# Lighter Background Service

A Node.js service that maintains a persistent connection to the Lighter trading platform and saves data to Firebase.

## Features

- 🔗 WebSocket connection to Lighter
- 📊 Real-time trading data sync
- 💾 Firebase data persistence  
- ❤️ Health monitoring
- 🔄 Auto-reconnection
- 📈 Market data for AI agents

## Setup

### 1. Install Dependencies
```bash
cd services
npm install
```

### 2. Environment Variables
Copy your `.env.local` from the main project or ensure these are set:
```bash
NEXT_PUBLIC_FIREBASE_API_KEY=your_key
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your_domain
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your_project
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your_bucket
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
NEXT_PUBLIC_FIREBASE_APP_ID=your_app_id
```

### 3. Configure Lighter Connection
Update the connection URLs in `lighter-background-service.js`:
- HTTP API: `http://localhost:8080/api/status`
- WebSocket: `ws://localhost:8080/ws`

Adjust these based on your Lighter setup.

## Running the Service

### Development
```bash
npm run dev
```

### Production (with PM2)
```bash
# Install PM2 globally
npm install -g pm2

# Start service
npm run pm2:start

# Check status
pm2 status

# View logs
npm run pm2:logs

# Stop service
npm run pm2:stop
```

### Manual Start
```bash
npm start
```

## Data Structure

The service saves data to these Firebase collections:

### `lighterData/balance`
- Current account balance
- Updated on balance changes

### `lighterData/positions/history`
- Position updates
- Trade history

### `lighterData/trades/executions`
- Individual trade executions
- Real-time trade data

### `marketData/latest`
- Current market prices
- Market indicators

### `agentContext/market`
- Processed data for AI agents
- Fear & Greed, funding rates, etc.

### `serviceStatus/lighterService`
- Service health status
- Connection status
- Uptime information

## Monitoring

Check service status in your web app or Firebase console:
- Service status: `serviceStatus/lighterService`
- Last data update: `lighterData/balance/lastUpdate`

## Troubleshooting

### Service won't start
1. Check Lighter is running on expected port
2. Verify Firebase credentials
3. Check network connectivity

### Connection issues
- Service auto-reconnects up to 10 times
- Check Lighter WebSocket endpoint
- Verify firewall settings

### Data not updating
- Check service logs: `npm run pm2:logs`
- Verify Firebase write permissions
- Check Lighter API responses

## Integration

Your web app will automatically receive real-time data through Firebase listeners. The agents will get updated market context for better trading analysis.