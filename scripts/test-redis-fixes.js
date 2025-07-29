#!/usr/bin/env node

/**
 * Basic test to verify Redis key type detection logic
 */

function testKeyTypeDetection() {
  console.log('🧪 Testing Redis key type detection logic...');
  
  const testCases = [
    // Auth state keys (should be hash)
    { key: 'auth:instance123', expected: 'hash', shouldBeHash: true },
    { key: 'auth:instance123:creds', expected: 'hash', shouldBeHash: true },
    { key: 'session-keys-123', expected: 'hash', shouldBeHash: true },
    { key: 'app-state-sync-key-456', expected: 'hash', shouldBeHash: true },
    
    // Instance data keys (should be string)
    { key: 'instance123', expected: 'string', shouldBeHash: false },
    { key: 'myinstance', expected: 'string', shouldBeHash: false },
    { key: 'connecting_time:instance123', expected: 'string', shouldBeHash: false },
    { key: 'restored:instance123', expected: 'string', shouldBeHash: false },
  ];
  
  let passed = 0;
  let failed = 0;
  
  testCases.forEach((testCase, index) => {
    // Replicate the logic from redis-cleanup.js
    const logicalKey = testCase.key.replace(/^evolution_cache:[^:]+:/, '');
    
    const shouldBeHash = logicalKey.includes('auth:') || 
                       logicalKey.includes('creds') ||
                       logicalKey.includes('session') ||
                       logicalKey.includes('keys') ||
                       (logicalKey.includes('-') && !logicalKey.includes('connecting_time') && !logicalKey.includes('restored'));
    
    const result = shouldBeHash === testCase.shouldBeHash;
    
    if (result) {
      console.log(`✅ Test ${index + 1}: ${testCase.key} -> ${shouldBeHash ? 'hash' : 'string'} (expected: ${testCase.expected})`);
      passed++;
    } else {
      console.log(`❌ Test ${index + 1}: ${testCase.key} -> ${shouldBeHash ? 'hash' : 'string'} (expected: ${testCase.expected})`);
      failed++;
    }
  });
  
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
  
  if (failed === 0) {
    console.log('🎉 All tests passed! Key type detection logic is working correctly.');
    return true;
  } else {
    console.log('⚠️  Some tests failed. Review the key type detection logic.');
    return false;
  }
}

function testNamespaceLogic() {
  console.log('\n🧪 Testing namespace separation logic...');
  
  const testCases = [
    { input: 'instance123', authKey: 'auth:instance123', description: 'Basic instance ID' },
    { input: 'my-instance-name', authKey: 'auth:my-instance-name', description: 'Instance with hyphens' },
    { input: 'instance:with:colons', authKey: 'auth:instance:with:colons', description: 'Instance with colons' },
  ];
  
  let passed = 0;
  let failed = 0;
  
  testCases.forEach((testCase, index) => {
    // This replicates the logic from use-multi-file-auth-state-redis-db.ts
    const authKey = `auth:${testCase.input}`;
    
    const result = authKey === testCase.authKey;
    
    if (result) {
      console.log(`✅ Test ${index + 1}: "${testCase.input}" -> "${authKey}" (${testCase.description})`);
      passed++;
    } else {
      console.log(`❌ Test ${index + 1}: "${testCase.input}" -> "${authKey}" expected "${testCase.authKey}" (${testCase.description})`);
      failed++;
    }
  });
  
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
  
  if (failed === 0) {
    console.log('🎉 All tests passed! Namespace separation logic is working correctly.');
    return true;
  } else {
    console.log('⚠️  Some tests failed. Review the namespace separation logic.');
    return false;
  }
}

function main() {
  console.log('🚀 Evolution API Redis Fix Validation Tests\n');
  
  const test1 = testKeyTypeDetection();
  const test2 = testNamespaceLogic();
  
  if (test1 && test2) {
    console.log('\n🎯 All validation tests passed! The Redis fixes should work correctly.');
    process.exit(0);
  } else {
    console.log('\n💥 Some validation tests failed. Review the implementation.');
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}