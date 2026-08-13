/**
 * AWS Systems Manager Parameter Store integration.
 *
 * When AWS_SSM_ENABLED=true, this module fetches secrets from AWS Parameter
 * Store and injects them into process.env BEFORE validateEnv() runs. This
 * allows production deployments to use AWS Parameter Store (free tier:
 * 10,000 standard parameters) instead of .env files on disk.
 *
 * Parameter naming convention:
 *   /lockdown/prod/JWT_SECRET       → process.env.JWT_SECRET
 *   /lockdown/prod/FIELD_ENCRYPTION_KEY → process.env.FIELD_ENCRYPTION_KEY
 *
 * Precedence: values already in process.env (e.g., from .env or Docker env)
 * take precedence over SSM values. SSM only fills in missing vars.
 */

const logger = require('../logger');

/**
 * Fetch all parameters under a path prefix from AWS SSM and inject them
 * into process.env (only if the env var is not already set).
 *
 * @returns {Promise<void>} — resolves after all parameters are loaded.
 *   Throws on unrecoverable errors (network, auth, etc.).
 */
async function loadSecretsFromSSM() {
  if (process.env.AWS_SSM_ENABLED !== 'true') {
    return;
  }

  // Lazy-load the SDK so it's not imported when SSM is disabled (keeps
  // the dependency optional for non-AWS deployments).
  let SSMClient, GetParametersByPathCommand;
  try {
    ({ SSMClient, GetParametersByPathCommand } = require('@aws-sdk/client-ssm'));
  } catch {
    logger.error(
      '[ssm] AWS_SSM_ENABLED=true but @aws-sdk/client-ssm is not installed. ' +
        'Run: npm install @aws-sdk/client-ssm',
    );
    throw new Error('AWS SDK not installed but AWS_SSM_ENABLED=true');
  }

  const prefix = process.env.AWS_SSM_PREFIX || '/lockdown/prod/';
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';

  const client = new SSMClient({ region });

  logger.info({ prefix, region }, '[ssm] Loading secrets from AWS Parameter Store');

  let nextToken;
  let loaded = 0;

  do {
    const response = await client.send(
      new GetParametersByPathCommand({
        Path: prefix,
        WithDecryption: true,
        NextToken: nextToken,
        MaxResults: 10, // AWS max for GetParametersByPath with decryption
      }),
    );

    for (const param of response.Parameters || []) {
      // Strip the prefix to get the env var name.
      // e.g., /lockdown/prod/JWT_SECRET → JWT_SECRET
      const name = param.Name.replace(prefix, '').replace(/\//g, '_');

      // Only set if not already in process.env — explicit env vars win.
      if (!process.env[name]) {
        process.env[name] = param.Value;
        loaded++;
      }
    }

    nextToken = response.NextToken;
  } while (nextToken);

  logger.info({ loaded }, '[ssm] Secrets loaded from AWS Parameter Store');
}

module.exports = { loadSecretsFromSSM };
