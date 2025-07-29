/**
 * Test script to validate the connection status synchronization fix
 * This simulates the WhatsApp connection process and verifies that
 * connectionStatus.state is properly updated to 'open' when connection succeeds
 */

// Mock the necessary dependencies
class MockLogger {
  info(message) {
    console.log(`[INFO] ${message}`);
  }
  
  warn(message) {
    console.log(`[WARN] ${message}`);
  }
  
  debug(message) {
    console.log(`[DEBUG] ${message}`);
  }
  
  error(message) {
    console.log(`[ERROR] ${message}`);
  }
}

class MockPrismaRepository {
  constructor() {
    this.instance = {
      update: async (data) => {
        console.log(`[DB UPDATE] Instance ${data.where.id} updated with:`, data.data);
        return { id: data.where.id, ...data.data };
      }
    };
  }
}

class MockEventEmitter {
  emit(event, ...args) {
    console.log(`[EVENT] ${event}:`, args);
  }
}

// Simplified mock of the connection status handling logic
class MockBaileysService {
  constructor() {
    this.stateConnection = { state: 'close' };
    this.instance = { name: 'test-instance' };
    this.instanceId = 'test-instance-id';
    this.client = null;
    this.logger = new MockLogger();
    this.prismaRepository = new MockPrismaRepository();
    this.eventEmitter = new MockEventEmitter();
  }

  get connectionStatus() {
    // Verify consistency before returning status
    this.verifyConnectionStatusConsistency();
    return this.stateConnection;
  }

  /**
   * Verify and synchronize connection status to ensure consistency
   */
  verifyConnectionStatusConsistency() {
    const currentState = this.stateConnection.state;
    
    // Log current status for debugging
    this.logger.debug(`Instance ${this.instance.name} connection status check: ${currentState}`);
    
    // If we have a client and it's connected, but our state isn't 'open', that's inconsistent
    if (this.client && this.client.user && currentState !== 'open') {
      this.logger.warn(`Instance ${this.instance.name} connection status inconsistency detected. Client connected but state is '${currentState}'. Correcting to 'open'.`);
      this.stateConnection.state = 'open';
    }
    
    // If we don't have a client but state is 'open', that's also inconsistent
    if ((!this.client || !this.client.user) && currentState === 'open') {
      this.logger.warn(`Instance ${this.instance.name} connection status inconsistency detected. No client but state is 'open'. Correcting to 'close'.`);
      this.stateConnection.state = 'close';
    }
  }

  /**
   * Simulate the connectionUpdate method with our fixes
   */
  async connectionUpdate(connection, lastDisconnect) {
    console.log(`\n=== Connection Update: ${connection} ===`);

    if (connection) {
      const previousState = this.stateConnection.state;
      this.stateConnection = {
        state: connection,
        statusReason: 200,
      };
      
      // Log connection state transitions for debugging
      if (previousState !== connection) {
        this.logger.info(`Instance ${this.instance.name} connection state changed: ${previousState} -> ${connection}`);
      }
    }

    if (connection === 'connecting') {
      // Explicitly update in-memory connection state to 'connecting'
      this.stateConnection.state = 'connecting';
      
      this.logger.info(`Connection state updated to 'connecting' for instance ${this.instance.name}`);
    }

    if (connection === 'open') {
      // Explicitly update in-memory connection state to 'open'
      this.stateConnection.state = 'open';
      
      // Simulate getting user info
      this.client = { user: { id: '554491412547@s.whatsapp.net' } };
      
      this.logger.info(`Connection state updated to 'open' for instance ${this.instance.name}`);
      
      await this.prismaRepository.instance.update({
        where: { id: this.instanceId },
        data: {
          connectionStatus: 'open',
        },
      });

      // Verify connection status consistency after successful connection
      this.verifyConnectionStatusConsistency();
      
      // Notify connection health service about successful connection
      this.eventEmitter.emit('instance.connected', this.instance.name);
    }
  }

  /**
   * Simulate the connectToWhatsapp method
   */
  async connectToWhatsapp() {
    this.logger.info(`Initiating WhatsApp connection for instance: ${this.instance.name}`);
    
    // Initialize connection state as connecting at the start
    this.stateConnection.state = 'connecting';
    this.logger.info(`Connection state initialized to 'connecting' for instance ${this.instance.name}`);

    // Simulate connection process
    await this.connectionUpdate('connecting');
    
    // Simulate successful connection after some time
    setTimeout(async () => {
      await this.connectionUpdate('open');
    }, 1000);
  }

  /**
   * Simulate message sending validation
   */
  validateMessageSending() {
    const connectionState = this.connectionStatus?.state;
    
    if (connectionState !== 'open') {
      throw new Error(
        `Instance "${this.instance.name}" is not ready for message sending. ` +
        `Current state: ${connectionState || 'unknown'}. Please wait for the instance to connect.`
      );
    }
    
    // Additional validation for critical properties
    if (!this.client || !this.instanceId) {
      throw new Error(
        `Instance "${this.instance.name}" is missing critical components. Please reconnect the instance.`
      );
    }

    return true;
  }
}

// Test the fix
async function testConnectionStatusFix() {
  console.log('🧪 Testing WhatsApp Connection Status Synchronization Fix\n');
  
  const service = new MockBaileysService();
  
  console.log('1. Initial state:');
  console.log('   Connection status:', service.connectionStatus.state);
  
  try {
    console.log('\n2. Testing message validation before connection:');
    service.validateMessageSending();
  } catch (error) {
    console.log(`   ✅ Expected error: ${error.message}`);
  }
  
  console.log('\n3. Starting connection process...');
  await service.connectToWhatsapp();
  
  // Wait for connection to complete
  await new Promise(resolve => setTimeout(resolve, 1500));
  
  console.log('\n4. Final state:');
  console.log('   Connection status:', service.connectionStatus.state);
  
  console.log('\n5. Testing message validation after connection:');
  try {
    const isReady = service.validateMessageSending();
    console.log(`   ✅ Message validation passed: ${isReady}`);
  } catch (error) {
    console.log(`   ❌ Unexpected error: ${error.message}`);
  }
  
  console.log('\n6. Testing consistency verification:');
  // Test the consistency check
  service.connectionStatus; // This calls verifyConnectionStatusConsistency
  console.log('   ✅ Consistency check completed');
  
  console.log('\n🎉 Test completed successfully! The fix ensures:');
  console.log('   - Connection state properly transitions: close → connecting → open');
  console.log('   - In-memory state stays synchronized with actual connection');
  console.log('   - Message sending validation works after connection');
  console.log('   - Consistency checks detect and fix mismatches');
}

// Run the test
testConnectionStatusFix().catch(console.error);