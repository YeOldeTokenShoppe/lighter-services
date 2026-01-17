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