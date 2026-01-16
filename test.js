console.log('🚀 Railway test service running!');
console.log('Environment variables loaded:', !!process.env.NEXT_PUBLIC_FIREBASE_API_KEY);

setInterval(() => {
  console.log('❤️ Service alive:', new Date().toISOString());
}, 30000);

// Keep process running
process.stdin.resume();