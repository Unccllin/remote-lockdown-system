// Set env vars needed by the server modules
process.env.JWT_SECRET = 'test-secret-key';
process.env.AGENT_SHARED_KEY = 'test-agent-key';
process.env.JWT_EXPIRES_IN = '1h';
process.env.CORS_ORIGIN = 'http://localhost:5173';
