#!/usr/bin/env node

/**
 * Redis Cleanup Utility for Evolution API
 * 
 * This script helps diagnose and fix Redis key type issues that cause
 * WRONGTYPE errors in Evolution API session management.
 * 
 * Usage:
 *   node scripts/redis-cleanup.js [options]
 * 
 * Options:
 *   --dry-run     Show what would be cleaned but don't delete anything
 *   --verbose     Show detailed information about each key
 *   --pattern     Filter keys by pattern (default: evolution_cache:*)
 *   --fix         Actually delete corrupted keys (without this, it's read-only)
 */

const Redis = require('redis');

async function main() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run');
  const isVerbose = args.includes('--verbose');
  const shouldFix = args.includes('--fix');
  const patternIndex = args.indexOf('--pattern');
  const pattern = patternIndex !== -1 && args[patternIndex + 1] 
    ? args[patternIndex + 1] 
    : 'evolution_cache:*';

  console.log('🔍 Evolution API Redis Cleanup Utility');
  console.log('=====================================');
  console.log(`Pattern: ${pattern}`);
  console.log(`Mode: ${shouldFix ? (isDryRun ? 'DRY RUN (simulation)' : 'FIX (will delete corrupted keys)') : 'READ-ONLY (inspection only)'}`);
  console.log(`Verbose: ${isVerbose ? 'ON' : 'OFF'}`);
  console.log('');

  try {
    // Load configuration from environment
    require('dotenv').config();
    
    const redisUri = process.env.CACHE_REDIS_URI || 'redis://localhost:6379';
    const redisEnabled = process.env.CACHE_REDIS_ENABLED === 'true';

    if (!redisEnabled) {
      console.error('❌ Redis is not enabled in configuration (CACHE_REDIS_ENABLED=true)');
      process.exit(1);
    }

    // Connect to Redis
    console.log(`🔌 Connecting to Redis: ${redisUri}`);
    const client = Redis.createClient({ url: redisUri });
    
    client.on('error', (err) => {
      console.error('❌ Redis error:', err);
    });

    await client.connect();
    console.log('✅ Connected to Redis successfully');

    // Scan for keys
    console.log(`\n🔍 Scanning for keys matching: ${pattern}`);
    const keys = [];
    
    for await (const key of client.scanIterator({
      MATCH: pattern,
      COUNT: 100,
    })) {
      keys.push(key);
    }

    console.log(`📊 Found ${keys.length} keys`);

    if (keys.length === 0) {
      console.log('🎉 No keys found matching the pattern');
      await client.quit();
      return;
    }

    // Analyze keys
    const stats = {
      total: keys.length,
      byType: {},
      corrupted: [],
      healthy: []
    };

    console.log('\n📋 Analyzing key types...');
    
    for (const key of keys) {
      try {
        const keyType = await client.type(key);
        
        if (!stats.byType[keyType]) {
          stats.byType[keyType] = 0;
        }
        stats.byType[keyType]++;

        // Extract logical key name
        const logicalKey = key.replace(/^evolution_cache:[^:]+:/, '');
        
        // Determine expected type based on key patterns
        const shouldBeHash = logicalKey.includes('auth:') || 
                           logicalKey.includes(':') || 
                           logicalKey.includes('-') ||
                           logicalKey.includes('creds') ||
                           logicalKey.includes('session') ||
                           logicalKey.includes('keys');
        
        const shouldBeString = !shouldBeHash;
        const expectedType = shouldBeHash ? 'hash' : 'string';
        
        const isCorrupted = (shouldBeHash && keyType !== 'hash') || 
                          (shouldBeString && keyType !== 'string' && keyType !== 'none');

        if (isVerbose) {
          console.log(`  ${key}`);
          console.log(`    Type: ${keyType} (expected: ${expectedType})`);
          console.log(`    Status: ${isCorrupted ? '❌ CORRUPTED' : '✅ OK'}`);
          console.log('');
        }

        if (isCorrupted) {
          stats.corrupted.push({ key, currentType: keyType, expectedType, logicalKey });
        } else {
          stats.healthy.push({ key, type: keyType });
        }

      } catch (error) {
        console.error(`❌ Error analyzing key ${key}:`, error.message);
        stats.corrupted.push({ key, error: error.message });
      }
    }

    // Display results
    console.log('\n📊 Analysis Results');
    console.log('==================');
    console.log(`Total keys: ${stats.total}`);
    console.log(`Healthy keys: ${stats.healthy.length}`);
    console.log(`Corrupted keys: ${stats.corrupted.length}`);
    console.log('\nBy type:');
    
    Object.entries(stats.byType).forEach(([type, count]) => {
      console.log(`  ${type}: ${count}`);
    });

    if (stats.corrupted.length > 0) {
      console.log('\n🚨 Corrupted Keys Found:');
      console.log('========================');
      
      stats.corrupted.forEach((item, index) => {
        console.log(`${index + 1}. ${item.key}`);
        if (item.error) {
          console.log(`   Error: ${item.error}`);
        } else {
          console.log(`   Current type: ${item.currentType}`);
          console.log(`   Expected type: ${item.expectedType}`);
          console.log(`   Logical key: ${item.logicalKey}`);
        }
        console.log('');
      });

      if (shouldFix) {
        if (isDryRun) {
          console.log('🧪 DRY RUN: Would delete the following keys:');
          stats.corrupted.forEach(item => {
            console.log(`  - ${item.key}`);
          });
        } else {
          console.log('🔧 Cleaning up corrupted keys...');
          let cleaned = 0;
          
          for (const item of stats.corrupted) {
            try {
              await client.del(item.key);
              console.log(`✅ Deleted: ${item.key}`);
              cleaned++;
            } catch (error) {
              console.error(`❌ Failed to delete ${item.key}:`, error.message);
            }
          }
          
          console.log(`\n🎉 Cleanup complete! Deleted ${cleaned} corrupted keys.`);
        }
      } else {
        console.log('💡 To fix these issues, run with --fix flag');
        console.log('💡 To see what would be deleted first, use --fix --dry-run');
      }
    } else {
      console.log('\n🎉 All keys are healthy! No corruption detected.');
    }

    await client.quit();
    console.log('\n✅ Redis cleanup utility completed');

  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { main };