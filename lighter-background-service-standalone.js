#!/usr/bin/env node

/**
 * Lighter Background Service - Standalone Mode
 * 
 * Runs without Lighter connection initially
 * Provides mock market data and agent context to Firebase
 * Can be easily extended when Lighter is available
 */

const axios = require('axios');
const { initializeApp } = require('firebase/app');
const { getFirestore, collection, addDoc, updateDoc, doc, serverTimestamp, setDoc } = require('firebase/firestore');

// Load environment variables
require('dotenv').config();

// Firebase configuration from environment
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID
};

class LighterStandaloneService {
  constructor() {
    this.isRunning = false;
    this.db = null;
    
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

    console.log('🚀 Starting Lighter Standalone Service...');
    this.isRunning = true;

    // Save service status
    await this.updateServiceStatus('starting');

    // Start data generation and health monitoring
    this.startMarketDataUpdates();
    this.startAgentContextUpdates();
    this.startHealthCheck();

    console.log('✅ Service started in standalone mode');
    await this.updateServiceStatus('running');

    // Handle graceful shutdown
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
  }

  startMarketDataUpdates() {
    // Fetch real market data every 60 seconds
    setInterval(async () => {
      if (!this.isRunning) return;
      
      try {
        // Fetch real BTC price from CoinGecko
        const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true', {
          timeout: 10000
        });

        if (response.data) {
          const marketData = {
            btcPrice: response.data.bitcoin.usd,
            ethPrice: response.data.ethereum.usd,
            btcChange24h: response.data.bitcoin.usd_24h_change || 0,
            ethChange24h: response.data.ethereum.usd_24h_change || 0,
            timestamp: serverTimestamp(),
            lastUpdate: new Date().toISOString()
          };

          await this.saveMarketData(marketData);
          console.log(`📊 Market updated: BTC $${marketData.btcPrice.toFixed(0)}, ETH $${marketData.ethPrice.toFixed(0)}`);
        }

      } catch (error) {
        console.error('❌ Error fetching market data:', error.message);
      }
    }, 60000);

    console.log('📈 Started market data updates (60s interval)');
  }

  startAgentContextUpdates() {
    // Update agent context every 120 seconds
    setInterval(async () => {
      if (!this.isRunning) return;

      try {
        // Fetch Fear & Greed Index
        const fearGreedResponse = await axios.get('https://api.alternative.me/fng/', {
          timeout: 10000
        });

        const fearGreedValue = fearGreedResponse.data?.data?.[0]?.value || 50;

        // Calculate mock funding rate and other indicators
        const fundingRate = (Math.random() - 0.5) * 0.02; // -1% to +1%
        const vix = 15 + Math.random() * 20; // 15-35 range

        const agentContext = {
          fearGreed: parseInt(fearGreedValue),
          fundingRate: fundingRate,
          vix: vix,
          marketSentiment: fearGreedValue > 75 ? 'extreme_greed' : 
                          fearGreedValue > 55 ? 'greed' :
                          fearGreedValue > 45 ? 'neutral' :
                          fearGreedValue > 25 ? 'fear' : 'extreme_fear',
          trend: this.calculateTrend(),
          timestamp: serverTimestamp(),
          lastUpdate: new Date().toISOString()
        };

        await setDoc(doc(this.db, 'agentContext', 'market'), agentContext, { merge: true });
        console.log(`🤖 Agent context updated: F&G=${fearGreedValue}, Funding=${(fundingRate*100).toFixed(3)}%`);

      } catch (error) {
        console.error('❌ Error updating agent context:', error.message);
      }
    }, 120000);

    console.log('🤖 Started agent context updates (120s interval)');
  }

  async saveMarketData(data) {
    try {
      await setDoc(doc(this.db, 'marketData', 'latest'), data, { merge: true });
    } catch (error) {
      console.error('❌ Error saving market data:', error);
    }
  }

  calculateTrend() {
    // Simple mock trend calculation
    const trends = ['bullish', 'bearish', 'sideways'];
    return trends[Math.floor(Math.random() * trends.length)];
  }

  startHealthCheck() {
    // Health check every 5 minutes
    setInterval(async () => {
      await this.updateServiceStatus('running', {
        lastPing: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        mode: 'standalone'
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
        mode: 'standalone',
        ...extra
      }, { merge: true });

    } catch (error) {
      console.error('❌ Error updating service status:', error);
    }
  }

  async shutdown() {
    console.log('🛑 Shutting down Lighter Standalone Service...');
    this.isRunning = false;

    await this.updateServiceStatus('stopped');
    console.log('✅ Service stopped gracefully');
    process.exit(0);
  }
}

// Start the service
const service = new LighterStandaloneService();
service.start().catch(error => {
  console.error('❌ Failed to start service:', error);
  process.exit(1);
});

module.exports = LighterStandaloneService;