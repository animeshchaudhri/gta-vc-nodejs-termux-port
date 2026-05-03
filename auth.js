'use strict';
/**
 * auth.js - Basic HTTP authentication middleware for Express.
 */

const crypto = require('crypto');

/**
 * Returns an Express middleware that enforces HTTP Basic Auth.
 * @param {string} username
 * @param {string} password
 */
function basicAuth(username, password) {
  return (req, res, next) => {
    // Allow CORS preflight through
    if (req.method === 'OPTIONS') return next();

    const header = req.headers['authorization'];
    if (!header) return sendUnauthorized(res);

    const [scheme, credentials] = header.split(' ');
    if (!scheme || scheme.toLowerCase() !== 'basic' || !credentials) {
      return sendUnauthorized(res);
    }

    let decoded;
    try {
      decoded = Buffer.from(credentials, 'base64').toString('utf8');
    } catch {
      return sendUnauthorized(res);
    }

    const colonIdx = decoded.indexOf(':');
    if (colonIdx === -1) return sendUnauthorized(res);

    const user = decoded.slice(0, colonIdx);
    const pass = decoded.slice(colonIdx + 1);

    // Constant-time comparison to prevent timing attacks
    const userOk = crypto.timingSafeEqual(Buffer.from(user), Buffer.from(username));
    const passOk = crypto.timingSafeEqual(Buffer.from(pass), Buffer.from(password));

    if (userOk && passOk) return next();
    return sendUnauthorized(res);
  };
}

function sendUnauthorized(res) {
  res.set('WWW-Authenticate', "Basic realm='Restricted'");
  res.status(401).send('Unauthorized');
}

module.exports = { basicAuth };
