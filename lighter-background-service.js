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
const { initializeApp } = require('firebase/app');
const { getFirestore, collection, addDoc, updateDoc, doc, serverTimestamp, setDoc } = require('firebase/firestore');

// Load environment variables
require('dotenv').config({ path: '../.env.local' });

// Firebase configuration
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID
};

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
      const app = initializeApp(firebaseConfig);
      this.db = getFirestore(app);
      console.log('✅ Firebase initialized');
    } catch (error) {
      console.error('❌ Firebase initialization failed:', error);
      process.exit(1);
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

  async saveBalanceUpdate(data) {
    try {
      await setDoc(doc(this.db, 'lighterData', 'balance'), {
        ...data,
        timestamp: serverTimestamp(),
        lastUpdate: new Date().toISOString()
      }, { merge: true });

      this.lastData.balance = data.balance;
      console.log(`💰 Balance updated: $${data.balance}`);
    } catch (error) {
      console.error('❌ Error saving balance:', error);
    }
  }

  async savePositionUpdate(data) {
    try {
      await addDoc(collection(this.db, 'lighterData', 'positions', 'history'), {
        ...data,
        timestamp: serverTimestamp(),
        createdAt: new Date().toISOString()
      });

      this.lastData.positions = data.positions || [];
      console.log(`📊 Position updated: ${data.positions?.length || 0} open positions`);
    } catch (error) {
      console.error('❌ Error saving position:', error);
    }
  }

  async saveTradeExecution(data) {
    try {
      await addDoc(collection(this.db, 'lighterData', 'trades', 'executions'), {
        ...data,
        timestamp: serverTimestamp(),
        executedAt: new Date().toISOString()
      });

      console.log(`⚡ Trade executed: ${data.side} ${data.size} ${data.symbol} @ ${data.price}`);
    } catch (error) {
      console.error('❌ Error saving trade:', error);
    }
  }

  async saveMarketData(data) {
    try {
      await setDoc(doc(this.db, 'marketData', 'latest'), {
        ...data,
        timestamp: serverTimestamp(),
        lastUpdate: new Date().toISOString()
      }, { merge: true });

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
      // Update market context that agents will use
      await setDoc(doc(this.db, 'agentContext', 'market'), {
        btcPrice: marketData.btcPrice,
        ethPrice: marketData.ethPrice,
        fearGreed: marketData.fearGreed || 45,
        fundingRate: marketData.fundingRate || 0.01,
        volume: marketData.volume,
        trend: this.calculateTrend(marketData),
        timestamp: serverTimestamp(),
        lastUpdate: new Date().toISOString()
      }, { merge: true });

    } catch (error) {
      console.error('❌ Error updating agent context:', error);
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
      await setDoc(doc(this.db, 'serviceStatus', 'lighterService'), {
        status,
        timestamp: serverTimestamp(),
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