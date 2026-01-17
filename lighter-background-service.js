#!/usr/bin/env node

/**
 * Lighter Background Service
 * 
 * Keeps a persistent connection to Lighter API/WebSocket
 * Saves trading data and market updates to Firebase
 * Runs independently of the web application
 */

const WebSocket = require('ws');
const axios = require('axios');
const admin = require('firebase-admin');
const { createServiceAccountFromEnv } = require('../firebase-env-fix');

// Load environment variables
require('dotenv').config({ path: '../.env.local' });

class LighterBackgroundService {
  constructor() {
    this.isRunning = false;
    this.ws = null;
    this.db = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 5000; // 5 seconds
    
    // Trading data cache
    this.lastData = {
      balance: 0,
      positions: [],
      pnl: 0,
      lastUpdate: null
    };

    // RL80 trading state
    this.rl80State = {
      lastDecisionId: null,
      lastExecutionTime: null,
      isExecuting: false,
      executionCount: 0,
      safetyChecks: {
        maxDailyTrades: 50,
        maxPositionSize: 0.1, // 10% of balance
        cooldownMs: 30000,    // 30 seconds between trades
      }
    };

    // Initialize Firebase
    this.initializeFirebase();
  }

  initializeFirebase() {
    try {
      console.log('🔧 Initializing Firebase Admin SDK...');
      
      // Check if Firebase is already initialized
      if (admin.apps.length > 0) {
        console.log('✅ Firebase already initialized, using existing instance');
        this.db = admin.firestore();
        return;
      }

      // Try to create service account from individual environment variables
      let serviceAccount;
      try {
        serviceAccount = createServiceAccountFromEnv();
        console.log('✅ Service account created from individual env vars');
      } catch (envError) {
        console.log('⚠️ Individual env vars failed, trying JSON fallback:', envError.message);
        
        // Fallback to JSON if individual vars fail
        if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
          try {
            serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
            console.log('✅ Service account parsed from JSON');
          } catch (jsonError) {
            throw new Error(`Both individual env vars and JSON parsing failed. JSON error: ${jsonError.message}`);
          }
        } else {
          throw new Error('No Firebase service account configuration found');
        }
      }

      // Initialize Firebase Admin
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: serviceAccount.project_id
      });

      this.db = admin.firestore();
      console.log('✅ Firebase Admin SDK initialized successfully');
      console.log('Project ID:', serviceAccount.project_id);
      
    } catch (error) {
      console.error('❌ Firebase initialization failed:', error);
      console.error('Error details:', error.message);
      this.db = null;
      
      // Don't exit process - continue without Firebase
      console.log('⚠️ Continuing without Firebase (some features disabled)');
    }
  }

  async start() {
    if (this.isRunning) {
      console.log('⚠️ Service already running');
      return;
    }

    console.log('🚀 Starting Lighter Background Service...');
    this.isRunning = true;

    // Save service status to Firebase
    await this.updateServiceStatus('starting');

    // Start connections
    this.connectToLighter();
    this.startDataPolling();
    this.startHealthCheck();
    this.startRL80DecisionMonitoring();

    // Handle graceful shutdown
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
  }

  async connectToLighter() {
    try {
      console.log('🔗 Connecting to Lighter...');

      // First, try to connect via HTTP to get initial data
      const response = await axios.get('http://localhost:8080/api/status', {
        timeout: 5000
      });

      if (response.status === 200) {
        console.log('✅ Lighter HTTP connection established');
        this.reconnectAttempts = 0;
        
        // Now try WebSocket connection
        this.connectWebSocket();
      }

    } catch (error) {
      console.error('❌ Failed to connect to Lighter:', error.message);
      this.scheduleReconnect();
    }
  }

  connectWebSocket() {
    try {
      // Connect to Lighter WebSocket (adjust URL based on your Lighter setup)
      this.ws = new WebSocket('ws://localhost:8080/ws');

      this.ws.on('open', () => {
        console.log('✅ WebSocket connected to Lighter');
        this.reconnectAttempts = 0;
        this.updateServiceStatus('connected');
      });

      this.ws.on('message', (data) => {
        this.handleLighterMessage(data);
      });

      this.ws.on('close', () => {
        console.log('🔌 WebSocket connection closed');
        this.updateServiceStatus('disconnected');
        this.scheduleReconnect();
      });

      this.ws.on('error', (error) => {
        console.error('❌ WebSocket error:', error);
        this.scheduleReconnect();
      });

    } catch (error) {
      console.error('❌ WebSocket connection failed:', error);
      this.scheduleReconnect();
    }
  }

  async handleLighterMessage(data) {
    try {
      const message = JSON.parse(data);
      
      // Save trading updates to Firebase
      switch (message.type) {
        case 'balance_update':
          await this.saveBalanceUpdate(message.data);
          break;
        
        case 'position_update':
          await this.savePositionUpdate(message.data);
          break;
        
        case 'trade_executed':
          await this.saveTradeExecution(message.data);
          break;
        
        case 'market_data':
          await this.saveMarketData(message.data);
          break;
        
        default:
          console.log('📊 Received:', message.type);
      }

    } catch (error) {
      console.error('❌ Error handling Lighter message:', error);
    }
  }

  // Helper to check if Firebase is available
  isFirebaseReady() {
    return this.db !== null;
  }

  async saveBalanceUpdate(data) {
    if (!this.isFirebaseReady()) {
      console.warn('⚠️ Firebase not ready, skipping balance update');
      return;
    }

    try {
      await this.db.collection('lighterData').doc('balance').set({
        ...data,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        lastUpdate: new Date().toISOString()
      }, { merge: true });

      this.lastData.balance = data.balance;
      console.log(`💰 Balance updated: $${data.balance}`);
    } catch (error) {
      console.error('❌ Error saving balance:', error);
    }
  }

  async savePositionUpdate(data) {
    if (!this.isFirebaseReady()) {
      console.warn('⚠️ Firebase not ready, skipping position update');
      return;
    }

    try {
      await this.db.collection('lighterData').doc('positions').collection('history').add({
        ...data,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: new Date().toISOString()
      });

      this.lastData.positions = data.positions || [];
      console.log(`📊 Position updated: ${data.positions?.length || 0} open positions`);
    } catch (error) {
      console.error('❌ Error saving position:', error);
    }
  }

  async saveTradeExecution(data) {
    if (!this.isFirebaseReady()) {
      console.warn('⚠️ Firebase not ready, skipping trade execution save');
      return;
    }

    try {
      await this.db.collection('lighterData').doc('trades').collection('executions').add({
        ...data,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        executedAt: new Date().toISOString()
      });

      console.log(`⚡ Trade executed: ${data.side} ${data.size} ${data.symbol} @ ${data.price}`);
    } catch (error) {
      console.error('❌ Error saving trade:', error);
    }
  }

  async saveMarketData(data) {
    if (!this.isFirebaseReady()) {
      console.warn('⚠️ Firebase not ready, skipping market data save');
      return;
    }

    try {
      await this.db.collection('marketData').doc('latest').set({
        ...data,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        lastUpdate: new Date().toISOString()
      }, { merge: true });

      console.log('📈 Market data saved');

      // Also save to agents for context
      if (data.btcPrice) {
        await this.updateAgentContext(data);
      }

    } catch (error) {
      console.error('❌ Error saving market data:', error);
    }
  }

  async updateAgentContext(marketData) {
    try {
      // Check if Firebase is properly initialized
      if (!this.db) {
        console.warn('⚠️ Firebase not initialized, skipping agent context update');
        return;
      }

      // Update market context that agents will use
      await this.db.collection('agentContext').doc('market').set({
        btcPrice: marketData.btcPrice,
        ethPrice: marketData.ethPrice,
        fearGreed: marketData.fearGreed || 45,
        fundingRate: marketData.fundingRate || 0.01,
        volume: marketData.volume,
        trend: this.calculateTrend(marketData),
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        lastUpdate: new Date().toISOString()
      }, { merge: true });

      console.log('✅ Agent context updated successfully');

    } catch (error) {
      console.error('❌ Error updating agent context:', error);
      console.error('Firebase DB state:', this.db ? 'initialized' : 'null');
      
      // Try to reinitialize Firebase if it's null
      if (!this.db) {
        console.log('🔄 Attempting to reinitialize Firebase...');
        this.initializeFirebase();
      }
    }
  }

  calculateTrend(data) {
    // Simple trend calculation
    if (data.priceChange24h > 2) return 'bullish';
    if (data.priceChange24h < -2) return 'bearish';
    return 'sideways';
  }

  startDataPolling() {
    // Poll Lighter API every 30 seconds for updates
    setInterval(async () => {
      if (!this.isRunning) return;

      try {
        const response = await axios.get('http://localhost:8080/api/portfolio', {
          timeout: 10000
        });

        if (response.data) {
          await this.saveBalanceUpdate(response.data);
        }

      } catch (error) {
        // Don't log every polling error, just connection issues
        if (error.code === 'ECONNREFUSED') {
          console.log('📡 Polling: Lighter not available');
        }
      }
    }, 30000);

    console.log('📊 Started data polling (30s interval)');
  }

  startHealthCheck() {
    // Health check every 5 minutes
    setInterval(async () => {
      await this.updateServiceStatus('running', {
        lastPing: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        reconnectAttempts: this.reconnectAttempts
      });
    }, 300000);

    console.log('❤️ Started health monitoring (5m interval)');
  }

  async updateServiceStatus(status, extra = {}) {
    try {
      if (!this.isFirebaseReady()) {
        console.warn('⚠️ Firebase not ready, skipping service status update');
        return;
      }

      await this.db.collection('serviceStatus').doc('lighterService').set({
        status,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        lastUpdate: new Date().toISOString(),
        pid: process.pid,
        ...extra
      }, { merge: true });

    } catch (error) {
      console.error('❌ Error updating service status:', error);
    }
  }

  scheduleReconnect() {
    if (!this.isRunning || this.reconnectAttempts >= this.maxReconnectAttempts) {
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        console.error('❌ Max reconnection attempts reached. Exiting.');
        this.shutdown();
      }
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * this.reconnectAttempts;
    
    console.log(`🔄 Reconnecting in ${delay/1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    
    setTimeout(() => {
      this.connectToLighter();
    }, delay);
  }

  // ============================================================================
  // RL80 DECISION MONITORING AND EXECUTION
  // ============================================================================

  async startRL80DecisionMonitoring() {
    if (!this.db) {
      console.log('⚠️ Firebase not available, skipping RL80 decision monitoring');
      return;
    }

    console.log('🤖 Starting RL80 decision monitoring...');

    try {
      // Listen for new RL80 decisions
      const rl80DecisionRef = this.db.collection('agentDecisions').doc('RL80');
      
      rl80DecisionRef.onSnapshot((doc) => {
        if (doc.exists) {
          this.handleRL80Decision(doc.data());
        }
      }, (error) => {
        console.error('❌ Error monitoring RL80 decisions:', error);
      });

      console.log('✅ RL80 decision monitoring started');
      
    } catch (error) {
      console.error('❌ Failed to start RL80 decision monitoring:', error);
    }
  }

  async handleRL80Decision(decision) {
    try {
      console.log('🤖 New RL80 decision received:', {
        action: decision.action,
        symbol: decision.symbol,
        confidence: decision.confidence,
        timestamp: decision.timestamp
      });

      // Check if this is a new decision
      const decisionId = `${decision.timestamp}_${decision.action}`;
      if (this.rl80State.lastDecisionId === decisionId) {
        console.log('⏭️ Skipping duplicate RL80 decision');
        return;
      }

      // Update decision tracking
      this.rl80State.lastDecisionId = decisionId;

      // Safety checks
      if (!this.passesSafetyChecks(decision)) {
        console.log('🛡️ RL80 decision failed safety checks, skipping execution');
        return;
      }

      // Execute the decision
      await this.executeRL80Decision(decision);

    } catch (error) {
      console.error('❌ Error handling RL80 decision:', error);
    }
  }

  passesSafetyChecks(decision) {
    const now = Date.now();
    const { safetyChecks } = this.rl80State;

    // Check cooldown period
    if (this.rl80State.lastExecutionTime && 
        (now - this.rl80State.lastExecutionTime) < safetyChecks.cooldownMs) {
      console.log('🚫 Safety check failed: Still in cooldown period');
      return false;
    }

    // Check if already executing
    if (this.rl80State.isExecuting) {
      console.log('🚫 Safety check failed: Already executing a trade');
      return false;
    }

    // Check confidence threshold (lowered to 0.5 to enable trading)
    if (decision.confidence < 0.5) {
      console.log('🚫 Safety check failed: Confidence too low:', decision.confidence);
      return false;
    }

    // Check for emergency stop
    if (decision.action === 'EMERGENCY_STOP') {
      console.log('🚨 Emergency stop received - halting all trading');
      this.rl80State.isExecuting = true; // Block future trades
      return false;
    }

    // Daily trade limit (reset at midnight)
    const today = new Date().toDateString();
    const lastExecutionDate = this.rl80State.lastExecutionTime ? 
      new Date(this.rl80State.lastExecutionTime).toDateString() : null;
    
    if (today !== lastExecutionDate) {
      this.rl80State.executionCount = 0; // Reset daily counter
    }
    
    if (this.rl80State.executionCount >= safetyChecks.maxDailyTrades) {
      console.log('🚫 Safety check failed: Daily trade limit reached');
      return false;
    }

    console.log('✅ RL80 decision passed all safety checks');
    return true;
  }

  async executeRL80Decision(decision) {
    this.rl80State.isExecuting = true;
    const startTime = Date.now();
    
    try {
      console.log(`🚀 Executing RL80 decision: ${decision.action} ${decision.symbol}`);

      let result;
      switch (decision.action.toUpperCase()) {
        case 'BUY':
          result = await this.executeBuyOrder(decision);
          break;
          
        case 'SELL':
          result = await this.executeSellOrder(decision);
          break;
          
        case 'HOLD':
          result = await this.executeHold(decision);
          break;
          
        default:
          console.log(`⚠️ Unknown RL80 action: ${decision.action}`);
          return;
      }

      // Update execution tracking
      this.rl80State.lastExecutionTime = Date.now();
      this.rl80State.executionCount++;

      // Log successful execution
      await this.logTradeExecution({
        rl80Decision: decision,
        result: result,
        executionTime: Date.now() - startTime,
        success: true
      });

      console.log(`✅ RL80 decision executed successfully: ${decision.action}`);

    } catch (error) {
      console.error('❌ Failed to execute RL80 decision:', error);
      
      // Log failed execution
      await this.logTradeExecution({
        rl80Decision: decision,
        error: error.message,
        executionTime: Date.now() - startTime,
        success: false
      });

    } finally {
      this.rl80State.isExecuting = false;
    }
  }

  async executeBuyOrder(decision) {
    console.log(`💰 Executing BUY order for ${decision.symbol}`);
    
    // Calculate position size based on confidence and safety limits
    const positionSize = this.calculatePositionSize(decision);
    
    // For now, simulate the Lighter SDK call
    // TODO: Replace with actual Lighter SDK trading calls
    const mockResult = {
      orderId: `buy_${Date.now()}`,
      symbol: decision.symbol,
      side: 'buy',
      size: positionSize,
      price: null, // Market order
      status: 'filled',
      timestamp: Date.now()
    };

    // Uncomment when Lighter SDK is available:
    // const result = await this.lighterSDK.placeMarketOrder({
    //   symbol: decision.symbol,
    //   side: 'buy',
    //   size: positionSize
    // });

    console.log(`📈 BUY order executed: ${positionSize} ${decision.symbol}`);
    return mockResult;
  }

  async executeSellOrder(decision) {
    console.log(`💸 Executing SELL order for ${decision.symbol}`);
    
    // Check current position before selling
    const currentPosition = this.getCurrentPosition(decision.symbol);
    if (!currentPosition || currentPosition.size <= 0) {
      console.log('⚠️ No position to sell, skipping SELL order');
      return { status: 'skipped', reason: 'no_position' };
    }

    // Calculate sell size (partial or full position)
    const sellSize = this.calculateSellSize(decision, currentPosition);
    
    // For now, simulate the Lighter SDK call
    const mockResult = {
      orderId: `sell_${Date.now()}`,
      symbol: decision.symbol,
      side: 'sell',
      size: sellSize,
      price: null, // Market order
      status: 'filled',
      timestamp: Date.now()
    };

    // Uncomment when Lighter SDK is available:
    // const result = await this.lighterSDK.placeMarketOrder({
    //   symbol: decision.symbol,
    //   side: 'sell',
    //   size: sellSize
    // });

    console.log(`📉 SELL order executed: ${sellSize} ${decision.symbol}`);
    return mockResult;
  }

  async executeHold(decision) {
    console.log(`⏸️ HOLD decision - no trading action taken`);
    
    // Log the hold decision for tracking
    return {
      action: 'hold',
      symbol: decision.symbol,
      reason: decision.reasoning,
      timestamp: Date.now()
    };
  }

  calculatePositionSize(decision) {
    // Base position size on confidence and available balance
    const baseSize = this.lastData.balance * this.rl80State.safetyChecks.maxPositionSize;
    const confidenceMultiplier = decision.confidence; // 0.6-1.0
    
    let positionSize = baseSize * confidenceMultiplier;
    
    // Apply position size override if provided
    if (decision.position_size) {
      positionSize = Math.min(positionSize, decision.position_size);
    }
    
    console.log(`📊 Calculated position size: ${positionSize.toFixed(4)} (confidence: ${decision.confidence})`);
    return positionSize;
  }

  calculateSellSize(decision, currentPosition) {
    // Default to selling 50% of position unless confidence is very high
    let sellRatio = decision.confidence > 0.8 ? 1.0 : 0.5;
    
    // Apply position size override if provided
    if (decision.position_size) {
      sellRatio = Math.min(sellRatio, decision.position_size / currentPosition.size);
    }
    
    return currentPosition.size * sellRatio;
  }

  getCurrentPosition(symbol) {
    // Find current position for the symbol
    return this.lastData.positions.find(pos => pos.symbol === symbol);
  }

  async logTradeExecution(executionData) {
    if (!this.db) return;

    try {
      await this.db.collection('lighterData').doc('trades').collection('rl80_executions').add({
        ...executionData,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        service_version: 'background_service_v1'
      });

      console.log('📝 Trade execution logged to Firebase');
      
    } catch (error) {
      console.error('❌ Error logging trade execution:', error);
    }
  }

  async shutdown() {
    console.log('🛑 Shutting down Lighter Background Service...');
    this.isRunning = false;

    if (this.ws) {
      this.ws.close();
    }

    await this.updateServiceStatus('stopped');
    console.log('✅ Service stopped gracefully');
    process.exit(0);
  }
}

// Start the service if run directly
if (require.main === module) {
  const service = new LighterBackgroundService();
  service.start().catch(error => {
    console.error('❌ Failed to start service:', error);
    process.exit(1);
  });
}

module.exports = LighterBackgroundService;