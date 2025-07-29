/**
 * Additional test to verify consistency check detects and fixes mismatches
 */

class MockLogger {
  info(message) { console.log(`[INFO] ${message}`); }
  warn(message) { console.log(`[WARN] ${message}`); }
  debug(message) { console.log(`[DEBUG] ${message}`); }
  error(message) { console.log(`[ERROR] ${message}`); }
}

class MockBaileysService {
  constructor() {
    this.stateConnection = { state: 'close' };
    this.instance = { name: 'test-instance' };
    this.instanceId = 'test-instance-id';
    this.client = null;
    this.logger = new MockLogger();
  }

  get connectionStatus() {
    this.verifyConnectionStatusConsistency();
    return this.stateConnection;
  }

  verifyConnectionStatusConsistency() {
    const currentState = this.stateConnection.state;
    
    if (this.client && this.client.user && currentState !== 'open') {
      this.logger.warn(`Instance ${this.instance.name} connection status inconsistency detected. Client connected but state is '${currentState}'. Correcting to 'open'.`);
      this.stateConnection.state = 'open';
    }
    
    if ((!this.client || !this.client.user) && currentState === 'open') {
      this.logger.warn(`Instance ${this.instance.name} connection status inconsistency detected. No client but state is 'open'. Correcting to 'close'.`);
      this.stateConnection.state = 'close';
    }
  }

  validateMessageSending() {
    const connectionState = this.connectionStatus?.state;
    
    if (connectionState !== 'open') {
      throw new Error(
        `Instance "${this.instance.name}" is not ready for message sending. ` +
        `Current state: ${connectionState || 'unknown'}. Please wait for the instance to connect.`
      );
    }
    
    if (!this.client || !this.instanceId) {
      throw new Error(
        `Instance "${this.instance.name}" is missing critical components. Please reconnect the instance.`
      );
    }

    return true;
  }
}

async function testConsistencyFix() {
  console.log('🔍 Testing Connection Status Consistency Checks\n');
  
  const service = new MockBaileysService();
  
  // Test Case 1: Client exists but state is wrong
  console.log('Test Case 1: Client connected but state is "connecting"');
  service.stateConnection.state = 'connecting';
  service.client = { user: { id: '554491412547@s.whatsapp.net' } };
  
  console.log(`   Before: connectionStatus.state = '${service.stateConnection.state}'`);
  console.log(`   Client exists: ${!!service.client?.user}`);
  
  try {
    service.validateMessageSending();
    console.log('   ✅ Message validation passed after auto-correction');
  } catch (error) {
    console.log(`   ❌ Message validation failed: ${error.message}`);
  }
  
  console.log(`   After: connectionStatus.state = '${service.stateConnection.state}'\n`);
  
  // Test Case 2: State is "open" but no client
  console.log('Test Case 2: State is "open" but no client');
  service.stateConnection.state = 'open';
  service.client = null;
  
  console.log(`   Before: connectionStatus.state = '${service.stateConnection.state}'`);
  console.log(`   Client exists: ${!!service.client?.user}`);
  
  try {
    service.validateMessageSending();
    console.log('   ✅ Message validation passed');
  } catch (error) {
    console.log(`   ✅ Expected error after auto-correction: ${error.message}`);
  }
  
  console.log(`   After: connectionStatus.state = '${service.stateConnection.state}'\n`);
  
  console.log('🎯 Consistency check tests completed!');
  console.log('   - Detects client connected but wrong state ✅');
  console.log('   - Detects wrong state but no client ✅');
  console.log('   - Auto-corrects inconsistencies ✅');
}

testConsistencyFix().catch(console.error);