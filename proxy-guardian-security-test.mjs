#!/usr/bin/env node

/**
 * ProxyGuardian Security & Performance Test Script
 * Usage: node proxy-guardian-security-test.mjs
 * 
 * Non-destructive tests - safe to run on production
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[36m';
const RESET = '\x1b[0m';

let results = [];
let passCount = 0;
let failCount = 0;

function log(status, title, details = '') {
  const icons = {
    PASS: `${GREEN}✓${RESET}`,
    FAIL: `${RED}✗${RESET}`,
    WARN: `${YELLOW}⚠${RESET}`,
    INFO: `${BLUE}ℹ${RESET}`
  };
  
  console.log(`${icons[status]} ${title}`);
  if (details) console.log(`  ${BLUE}→${RESET} ${details}`);
  
  results.push({ status, title, details });
  if (status === 'PASS') passCount++;
  if (status === 'FAIL') failCount++;
}

function test(title, fn) {
  try {
    fn();
  } catch (err) {
    log('FAIL', title, err.message);
  }
}

console.log(`\n${BLUE}╔════════════════════════════════════════╗${RESET}`);
console.log(`${BLUE}║  ProxyGuardian Security Test Suite     ║${RESET}`);
console.log(`${BLUE}╚════════════════════════════════════════╝${RESET}\n`);

// ========== FILE SYSTEM CHECKS ==========
console.log(`${BLUE}[1] File System & Configuration${RESET}\n`);

test('Check .env file exists', () => {
  const envPath = path.resolve('.env');
  if (fs.existsSync(envPath)) {
    log('PASS', '.env file found', envPath);
  } else {
    throw new Error('.env not found');
  }
});

test('Check .env permissions', () => {
  const envPath = path.resolve('.env');
  const stats = fs.statSync(envPath);
  const octal = (stats.mode & parseInt('777', 8)).toString(8);
  
  if (octal === '600' || octal === '640') {
    log('PASS', '.env permissions restrictive', `Mode: 0${octal}`);
  } else {
    log('WARN', '.env permissions too open', `Mode: 0${octal} (should be 600 or 640)`);
  }
});

test('Check package.json exists', () => {
  const pkgPath = path.resolve('package.json');
  if (fs.existsSync(pkgPath)) {
    log('PASS', 'package.json found');
  } else {
    throw new Error('package.json not found');
  }
});

test('Check for hardcoded secrets in package.json', () => {
  const pkgPath = path.resolve('package.json');
  const content = fs.readFileSync(pkgPath, 'utf8');
  const secretPatterns = [
    /password\s*[:=]\s*['"](.*)['"]/gi,
    /api[_-]?key\s*[:=]\s*['"](.*)['"]/gi,
    /secret\s*[:=]\s*['"](.*)['"]/gi,
    /token\s*[:=]\s*['"](.*)['"]/gi
  ];
  
  let found = false;
  for (const pattern of secretPatterns) {
    if (pattern.test(content)) {
      found = true;
      break;
    }
  }
  
  if (!found) {
    log('PASS', 'No hardcoded secrets in package.json');
  } else {
    log('FAIL', 'Potential hardcoded secrets detected in package.json');
  }
});

// ========== AUTHENTICATION CHECKS ==========
console.log(`\n${BLUE}[2] Authentication & Passwords${RESET}\n`);

test('Check if auth.ts uses bcrypt', () => {
  const authPath = path.resolve('server/auth.ts');
  if (fs.existsSync(authPath)) {
    const content = fs.readFileSync(authPath, 'utf8');
    if (content.includes('bcrypt')) {
      log('PASS', 'bcrypt detected in auth.ts');
    } else if (content.includes('SHA256') || content.includes('sha256')) {
      log('FAIL', 'SHA256 hashing detected - use bcrypt instead');
    } else if (content.includes('crypto.') && !content.includes('scrypt')) {
      log('WARN', 'Generic crypto usage - verify password hashing algorithm');
    } else {
      log('WARN', 'Unable to determine password hashing method');
    }
  } else {
    log('WARN', 'auth.ts not found - cannot verify password hashing');
  }
});

test('Check for password validation', () => {
  const routesPath = path.resolve('server/routes.ts');
  if (fs.existsSync(routesPath)) {
    const content = fs.readFileSync(routesPath, 'utf8');
    const hasValidation = content.includes('password') && 
                         (content.includes('length') || content.includes('strength') || content.includes('regex'));
    if (hasValidation) {
      log('PASS', 'Password validation rules found');
    } else {
      log('WARN', 'Password validation not clearly detected');
    }
  }
});

// ========== API SECURITY CHECKS ==========
console.log(`\n${BLUE}[3] API Security${RESET}\n`);

test('Check for CORS configuration', () => {
  const indexPath = path.resolve('server/index.ts');
  if (fs.existsSync(indexPath)) {
    const content = fs.readFileSync(indexPath, 'utf8');
    if (content.includes('cors') || content.includes('CORS')) {
      log('PASS', 'CORS configuration found');
    } else {
      log('WARN', 'CORS not explicitly configured');
    }
  }
});

test('Check for rate limiting', () => {
  const indexPath = path.resolve('server/index.ts');
  const routesPath = path.resolve('server/routes.ts');
  let rateLimit = false;
  
  if (fs.existsSync(indexPath)) {
    const content = fs.readFileSync(indexPath, 'utf8');
    if (content.includes('rate') || content.includes('throttle') || content.includes('RateLimit')) {
      rateLimit = true;
    }
  }
  
  if (fs.existsSync(routesPath) && !rateLimit) {
    const content = fs.readFileSync(routesPath, 'utf8');
    if (content.includes('rate') || content.includes('throttle')) {
      rateLimit = true;
    }
  }
  
  if (rateLimit) {
    log('PASS', 'Rate limiting detected');
  } else {
    log('FAIL', 'No rate limiting found - brute force attacks possible');
  }
});

test('Check for security headers (Helmet)', () => {
  const indexPath = path.resolve('server/index.ts');
  if (fs.existsSync(indexPath)) {
    const content = fs.readFileSync(indexPath, 'utf8');
    if (content.includes('helmet')) {
      log('PASS', 'Helmet security headers detected');
    } else if (content.includes('X-Content-Type-Options') || content.includes('X-Frame-Options')) {
      log('WARN', 'Manual security headers (use Helmet for comprehensive protection)');
    } else {
      log('FAIL', 'No security headers detected');
    }
  }
});

test('Check for CSRF protection', () => {
  const indexPath = path.resolve('server/index.ts');
  const routesPath = path.resolve('server/routes.ts');
  let csrf = false;
  
  if (fs.existsSync(indexPath)) {
    const content = fs.readFileSync(indexPath, 'utf8');
    if (content.includes('csrf')) {
      csrf = true;
    }
  }
  
  if (fs.existsSync(routesPath) && !csrf) {
    const content = fs.readFileSync(routesPath, 'utf8');
    if (content.includes('csrf') || content.includes('CSRF')) {
      csrf = true;
    }
  }
  
  if (csrf) {
    log('PASS', 'CSRF protection detected');
  } else {
    log('FAIL', 'No CSRF protection - POST/PUT/DELETE requests vulnerable');
  }
});

// ========== INPUT VALIDATION ==========
console.log(`\n${BLUE}[4] Input Validation${RESET}\n`);

test('Check for Zod schema validation', () => {
  const schemaPath = path.resolve('shared/schema.ts');
  if (fs.existsSync(schemaPath)) {
    const content = fs.readFileSync(schemaPath, 'utf8');
    if (content.includes('z.') || content.includes('zod')) {
      log('PASS', 'Zod validation schemas found');
    } else {
      log('WARN', 'Zod not detected in schema file');
    }
  } else {
    log('WARN', 'shared/schema.ts not found');
  }
});

test('Check for input sanitization', () => {
  const routesPath = path.resolve('server/routes.ts');
  if (fs.existsSync(routesPath)) {
    const content = fs.readFileSync(routesPath, 'utf8');
    const sanitizePatterns = [
      /sanitize|escape|filter|clean/i,
      /xss|injection|sql/i
    ];
    
    let found = false;
    for (const pattern of sanitizePatterns) {
      if (pattern.test(content)) {
        found = true;
        break;
      }
    }
    
    if (found) {
      log('PASS', 'Input sanitization logic detected');
    } else {
      log('WARN', 'No explicit input sanitization found');
    }
  }
});

test('Check for SQL injection protection', () => {
  const storPath = path.resolve('server/storage.ts');
  if (fs.existsSync(storPath)) {
    const content = fs.readFileSync(storPath, 'utf8');
    if (content.includes('JSON') || !content.includes('query') || !content.includes('execute')) {
      log('PASS', 'Using file storage (no SQL injection risk)');
    }
  }
});

// ========== SHELL COMMAND INJECTION ==========
console.log(`\n${BLUE}[5] Command Injection & Shell Safety${RESET}\n`);

test('Check for shell command execution', () => {
  const routesPath = path.resolve('server/routes.ts');
  let shellCalls = 0;
  
  if (fs.existsSync(routesPath)) {
    const content = fs.readFileSync(routesPath, 'utf8');
    shellCalls += (content.match(/exec\(/g) || []).length;
    shellCalls += (content.match(/spawn\(/g) || []).length;
    shellCalls += (content.match(/shell:\s*true/g) || []).length;
  }
  
  if (shellCalls === 0) {
    log('PASS', 'No shell command execution detected');
  } else {
    log('WARN', `Found ${shellCalls} shell command calls - verify they escape user input`);
  }
});

test('Check for git command injection', () => {
  const routesPath = path.resolve('server/routes.ts');
  if (fs.existsSync(routesPath)) {
    const content = fs.readFileSync(routesPath, 'utf8');
    if (content.includes('git') && content.includes('exec')) {
      log('WARN', 'Git commands with exec() found - verify proper escaping');
    } else if (content.includes('git')) {
      log('INFO', 'Git commands found - check escaping manually');
    }
  }
});

// ========== SECRETS & ENCRYPTION ==========
console.log(`\n${BLUE}[6] Secrets Management & Encryption${RESET}\n`);

test('Check for API key storage encryption', () => {
  const vpsPath = path.resolve('server/vps-manager.ts');
  if (fs.existsSync(vpsPath)) {
    const content = fs.readFileSync(vpsPath, 'utf8');
    if (content.includes('encrypt') || content.includes('cipher') || content.includes('crypto')) {
      log('PASS', 'API key encryption detected');
    } else if (content.includes('apiKey') || content.includes('api_key')) {
      log('FAIL', 'API keys stored without encryption - data at risk');
    } else {
      log('WARN', 'Cannot determine API key storage method');
    }
  }
});

test('Check environment variable usage', () => {
  const indexPath = path.resolve('server/index.ts');
  if (fs.existsSync(indexPath)) {
    const content = fs.readFileSync(indexPath, 'utf8');
    const envVars = content.match(/process\.env\.\w+/g) || [];
    if (envVars.length > 0) {
      log('PASS', `Using ${new Set(envVars).size} environment variables`);
    } else {
      log('WARN', 'No environment variables found');
    }
  }
});

// ========== SESSION SECURITY ==========
console.log(`\n${BLUE}[7] Session Management${RESET}\n`);

test('Check session configuration', () => {
  const indexPath = path.resolve('server/index.ts');
  if (fs.existsSync(indexPath)) {
    const content = fs.readFileSync(indexPath, 'utf8');
    const hasSecure = content.includes('secure:') || content.includes('secure: true');
    const hasHttpOnly = content.includes('httpOnly:') || content.includes('httpOnly: true');
    const hasSameSite = content.includes('sameSite');
    
    const secure = hasSecure ? 'PASS' : 'FAIL';
    const httpOnly = hasHttpOnly ? 'PASS' : 'FAIL';
    const sameSite = hasSameSite ? 'PASS' : 'FAIL';
    
    log(secure, 'Session cookie secure flag');
    log(httpOnly, 'Session cookie httpOnly flag');
    log(sameSite, 'Session cookie sameSite attribute');
  }
});

// ========== DEPENDENCY CHECK ==========
console.log(`\n${BLUE}[8] Dependencies${RESET}\n`);

test('Check package.json for outdated patterns', () => {
  const pkgPath = path.resolve('package.json');
  const content = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(content);
  
  const deprecated = ['body-parser', 'multer-express'];
  const found = Object.keys(pkg.dependencies || {})
    .concat(Object.keys(pkg.devDependencies || {}))
    .filter(dep => deprecated.includes(dep));
  
  if (found.length === 0) {
    log('PASS', 'No deprecated packages detected');
  } else {
    log('WARN', `Found deprecated packages: ${found.join(', ')}`);
  }
});

test('Check for security-related dependencies', () => {
  const pkgPath = path.resolve('package.json');
  const content = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(content);
  
  const allDeps = {
    ...pkg.dependencies,
    ...pkg.devDependencies
  };
  
  const securityTools = {
    'helmet': 'Security headers',
    'express-rate-limit': 'Rate limiting',
    'bcryptjs': 'Password hashing',
    'joi': 'Input validation',
    'zod': 'Schema validation'
  };
  
  const present = Object.keys(securityTools)
    .filter(tool => tool in allDeps);
  
  if (present.length > 0) {
    log('PASS', `Security tools installed: ${present.join(', ')}`);
  } else {
    log('WARN', 'Consider adding: helmet, express-rate-limit, or bcryptjs');
  }
});

// ========== LOGGING & MONITORING ==========
console.log(`\n${BLUE}[9] Logging & Monitoring${RESET}\n`);

test('Check for structured logging', () => {
  const indexPath = path.resolve('server/index.ts');
  if (fs.existsSync(indexPath)) {
    const content = fs.readFileSync(indexPath, 'utf8');
    if (content.includes('winston') || content.includes('pino') || content.includes('bunyan')) {
      log('PASS', 'Structured logging library detected');
    } else if (content.includes('console.log')) {
      log('WARN', 'Using console.log - consider structured logging for production');
    }
  }
});

test('Check for audit logging', () => {
  const routesPath = path.resolve('server/routes.ts');
  let hasAudit = false;
  
  if (fs.existsSync(routesPath)) {
    const content = fs.readFileSync(routesPath, 'utf8');
    hasAudit = content.includes('audit') || content.includes('log');
  }
  
  if (hasAudit) {
    log('PASS', 'Audit logging found');
  } else {
    log('FAIL', 'No audit logging detected - compliance risk');
  }
});

// ========== PERFORMANCE ==========
console.log(`\n${BLUE}[10] Performance & Scalability${RESET}\n`);

test('Check for caching implementation', () => {
  const indexPath = path.resolve('server/index.ts');
  let caching = false;
  
  if (fs.existsSync(indexPath)) {
    const content = fs.readFileSync(indexPath, 'utf8');
    caching = content.includes('cache') || content.includes('redis') || content.includes('memcache');
  }
  
  if (caching) {
    log('PASS', 'Caching detected');
  } else {
    log('WARN', 'No caching layer - consider Redis for performance');
  }
});

test('Check for database usage', () => {
  const storagePath = path.resolve('server/storage.ts');
  if (fs.existsSync(storagePath)) {
    const content = fs.readFileSync(storagePath, 'utf8');
    if (content.includes('prisma') || content.includes('typeorm') || content.includes('sequelize')) {
      log('PASS', 'Database ORM detected');
    } else if (content.includes('.json') || content.includes('fs.')) {
      log('WARN', 'Using file-based storage - not suitable for production at scale');
    }
  }
});

test('Check for pagination', () => {
  const routesPath = path.resolve('server/routes.ts');
  if (fs.existsSync(routesPath)) {
    const content = fs.readFileSync(routesPath, 'utf8');
    if (content.includes('limit') || content.includes('offset') || content.includes('page')) {
      log('PASS', 'Pagination logic found');
    } else {
      log('WARN', 'No pagination detected - large result sets not handled');
    }
  }
});

// ========== SUMMARY ==========
console.log(`\n${BLUE}╔════════════════════════════════════════╗${RESET}`);
console.log(`${BLUE}║  Test Summary                          ║${RESET}`);
console.log(`${BLUE}╚════════════════════════════════════════╝${RESET}\n`);

const total = passCount + failCount;
const percentage = total > 0 ? Math.round((passCount / total) * 100) : 0;

console.log(`${GREEN}✓ Passed:${RESET} ${passCount}`);
console.log(`${RED}✗ Failed:${RESET} ${failCount}`);
console.log(`Total: ${total}\n`);

if (percentage >= 80) {
  console.log(`${GREEN}Security Score: ${percentage}% (Good)${RESET}`);
} else if (percentage >= 60) {
  console.log(`${YELLOW}Security Score: ${percentage}% (Fair - improvements needed)${RESET}`);
} else {
  console.log(`${RED}Security Score: ${percentage}% (Poor - critical fixes required)${RESET}`);
}

console.log(`\n${BLUE}Next Steps:${RESET}`);
console.log('1. Fix all FAIL items (shown above with ✗)');
console.log('2. Address WARN items as soon as practical');
console.log('3. Run this test again after making changes\n');
