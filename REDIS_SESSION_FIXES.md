# Redis Session Management Fixes

This document outlines the fixes implemented to resolve Redis WRONGTYPE errors that were causing WhatsApp connection failures after restart or redeploy.

## 🐛 Issues Fixed

### 1. Redis Key Type Mismatch (WRONGTYPE Errors)
**Problem**: The system was mixing Redis string operations (`.set()`, `.get()`) and hash operations (`.hSet()`, `.hGet()`) on the same keys, causing `WRONGTYPE Operation against a key holding the wrong kind of value` errors.

**Root Cause**: 
- Authentication state used hash operations: `cache.hSet(instanceName, 'creds', data)`
- Instance session data used string operations: `cache.set(instanceId, instanceData)`
- Both could target the same Redis key, creating type conflicts

**Fix**: 
- Separated auth state keys with `auth:` namespace prefix
- Added automatic WRONGTYPE error detection and recovery
- Implemented key type validation and cleanup

### 2. No Fallback Mechanism on Redis Failures
**Problem**: When Redis failed, the system would immediately trigger `instance.logout()` instead of falling back to database storage.

**Fix**:
- Added graceful fallback to database storage when Redis operations fail
- Enhanced error handling to continue with in-memory state when persistence fails
- Implemented cache availability checking before forcing logout

### 3. QR Code Generation Spam
**Problem**: Failed Redis operations would reset QR state and repeatedly generate new QR codes, creating loops.

**Fix**:
- Added minimum 1-minute interval between QR code generations
- Enhanced QR state tracking with timestamps
- Better validation before QR code generation

### 4. Insufficient Error Logging
**Problem**: Redis errors were logged but didn't provide enough context for debugging key type issues.

**Fix**:
- Added detailed logging for Redis operations with key types
- Verbose logging for auth state operations
- Enhanced error messages with context

## 🔧 Enhanced Components

### RedisCache (`src/cache/rediscache.ts`)
- Added `handleWrongTypeError()` method for automatic error recovery
- Implemented `getKeyType()` for debugging key types
- Added `cleanupCorruptedKeys()` for maintenance
- Enhanced error handling with retry logic

### Auth State Provider (`src/utils/use-multi-file-auth-state-redis-db.ts`)
- Separated auth keys with `auth:` namespace to prevent conflicts
- Added graceful error handling that doesn't crash authentication
- Enhanced logging for auth state operations

### Session Restoration Service (`src/api/services/session-restoration.service.ts`)
- Added Redis key cleanup before restoration
- Implemented fallback to database when Redis fails
- Enhanced validation of instance data before restoration

### WAMonitoringService (`src/api/services/monitor.service.ts`)
- Added cache availability checking before logout decisions
- Implemented recovery attempts instead of immediate logout
- Enhanced timeout logic with intelligent retry

### Baileys Service (`src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts`)
- Added QR code spam prevention with timing controls
- Enhanced auth state error handling with fallbacks
- Better logging for connection state changes

## 🛠 Redis Cleanup Utility

A comprehensive Redis diagnostic and cleanup tool is now available:

```bash
# Check Redis key health (read-only)
npm run redis:check

# Verbose inspection
npm run redis:check:verbose

# Simulate cleanup (dry run)
npm run redis:cleanup:dry

# Actually clean up corrupted keys
npm run redis:cleanup
```

### Manual Usage
```bash
# Basic inspection
node scripts/redis-cleanup.js

# Detailed analysis
node scripts/redis-cleanup.js --verbose

# Dry run cleanup
node scripts/redis-cleanup.js --fix --dry-run

# Actually fix issues
node scripts/redis-cleanup.js --fix

# Custom pattern
node scripts/redis-cleanup.js --pattern "evolution_cache:instance:*" --verbose
```

## 🔄 Session Recovery Flow

The enhanced system now follows this recovery flow:

1. **Primary**: Try to restore from Redis cache
   - Clean up corrupted keys automatically
   - Use separate namespaces for auth vs instance data
   
2. **Fallback 1**: If Redis fails, try database restoration
   - Query database for connected instances
   - Restore instance configuration and state
   
3. **Fallback 2**: If both fail, create fresh session
   - Don't force logout due to storage failures
   - Allow manual QR scanning with rate limiting

## 🚨 Error Scenarios Handled

### WRONGTYPE Redis Errors
- **Detection**: Automatic detection in Redis operations
- **Recovery**: Delete corrupted key and retry operation
- **Logging**: Detailed error logging with key type information

### Redis Connection Failures
- **Detection**: Cache availability testing
- **Recovery**: Fallback to database storage
- **Logging**: Clear indication of fallback usage

### Session Restoration Failures
- **Detection**: Validation of restored data structure
- **Recovery**: Skip corrupted entries, continue with others
- **Logging**: Detailed restoration attempt logging

## 📊 Monitoring and Debugging

### Key Logging Points
1. Redis operation success/failure with key types
2. Auth state load/save operations with error context
3. Session restoration attempts and outcomes
4. QR code generation timing and rate limiting
5. Cache availability checks and fallback decisions

### Debug Commands
```bash
# Check Redis key types
npm run redis:check:verbose

# Monitor session restoration
# Check logs for "SessionRestorationService" entries

# Monitor auth state issues
# Check logs for "useMultiFileAuthStateRedisDb" entries

# Monitor cache availability
# Check logs for "Cache availability check" entries
```

## 🎯 Prevention Measures

1. **Key Namespace Separation**: Auth state uses `auth:` prefix to avoid conflicts
2. **Type Validation**: Automatic detection and cleanup of wrong key types
3. **Graceful Degradation**: System continues working even when Redis fails
4. **Rate Limiting**: QR code generation is throttled to prevent spam
5. **Health Monitoring**: Regular cache availability checks

## 🔮 Future Improvements

1. **Metrics**: Add Prometheus metrics for Redis operation success rates
2. **Alerting**: Set up alerts for high WRONGTYPE error rates
3. **Auto-healing**: Periodic background cleanup of corrupted keys
4. **Performance**: Optimize Redis operations for better reliability
5. **Testing**: Add integration tests for Redis failure scenarios

## 📝 Configuration

### Environment Variables
```bash
# Enable Redis caching
CACHE_REDIS_ENABLED=true
CACHE_REDIS_URI=redis://localhost:6379
CACHE_REDIS_PREFIX_KEY=evolution_cache

# Enable database fallback
DATABASE_SAVE_DATA_INSTANCE=true

# Enable session restoration
DATABASE_SAVE_DATA_INSTANCE=true
CACHE_REDIS_SAVE_INSTANCES=true
```

### Recommended Settings
- Keep both Redis and database persistence enabled for redundancy
- Set reasonable TTL values to prevent memory buildup
- Monitor Redis memory usage and set appropriate limits
- Regular cleanup runs to maintain Redis health