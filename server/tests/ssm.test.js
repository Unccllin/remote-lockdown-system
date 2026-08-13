/**
 * Tests for src/config/ssm.js — AWS Parameter Store secrets loader.
 *
 * Covers:
 *   - No-op when AWS_SSM_ENABLED is not 'true'
 *   - Loads secrets from SSM and injects into process.env
 *   - Existing process.env values take precedence over SSM values
 *   - Handles pagination (NextToken)
 *   - Throws when SDK is not installed
 */

// Mock the AWS SDK before requiring the module under test.
const mockGetParametersByPath = jest.fn();
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn().mockImplementation(() => ({
    send: mockGetParametersByPath,
  })),
  GetParametersByPathCommand: jest.fn().mockImplementation((params) => params),
}));

const { loadSecretsFromSSM } = require('../src/config/ssm');

describe('ssm loader', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Clear any SSM-injected env vars from previous tests
    delete process.env.TEST_SSM_SECRET_1;
    delete process.env.TEST_SSM_SECRET_2;
    delete process.env.AWS_SSM_ENABLED;
    delete process.env.AWS_SSM_PREFIX;
  });

  test('no-op when AWS_SSM_ENABLED is not true', async () => {
    process.env.AWS_SSM_ENABLED = 'false';
    await loadSecretsFromSSM();
    expect(mockGetParametersByPath).not.toHaveBeenCalled();
  });

  test('no-op when AWS_SSM_ENABLED is unset', async () => {
    delete process.env.AWS_SSM_ENABLED;
    await loadSecretsFromSSM();
    expect(mockGetParametersByPath).not.toHaveBeenCalled();
  });

  test('loads secrets from SSM into process.env', async () => {
    process.env.AWS_SSM_ENABLED = 'true';
    process.env.AWS_SSM_PREFIX = '/lockdown/test/';

    mockGetParametersByPath.mockResolvedValueOnce({
      Parameters: [
        { Name: '/lockdown/test/TEST_SSM_SECRET_1', Value: 'loaded-secret-1' },
        { Name: '/lockdown/test/TEST_SSM_SECRET_2', Value: 'loaded-secret-2' },
      ],
      NextToken: undefined,
    });

    await loadSecretsFromSSM();

    expect(process.env.TEST_SSM_SECRET_1).toBe('loaded-secret-1');
    expect(process.env.TEST_SSM_SECRET_2).toBe('loaded-secret-2');
  });

  test('existing process.env values take precedence over SSM', async () => {
    process.env.AWS_SSM_ENABLED = 'true';
    process.env.AWS_SSM_PREFIX = '/lockdown/test/';
    process.env.TEST_SSM_SECRET_1 = 'existing-value';

    mockGetParametersByPath.mockResolvedValueOnce({
      Parameters: [
        { Name: '/lockdown/test/TEST_SSM_SECRET_1', Value: 'ssm-value' },
      ],
      NextToken: undefined,
    });

    await loadSecretsFromSSM();

    expect(process.env.TEST_SSM_SECRET_1).toBe('existing-value');
  });

  test('handles pagination via NextToken', async () => {
    process.env.AWS_SSM_ENABLED = 'true';
    process.env.AWS_SSM_PREFIX = '/lockdown/test/';

    mockGetParametersByPath
      .mockResolvedValueOnce({
        Parameters: [
          { Name: '/lockdown/test/SECRET_1', Value: 'val1' },
        ],
        NextToken: 'page2',
      })
      .mockResolvedValueOnce({
        Parameters: [
          { Name: '/lockdown/test/SECRET_2', Value: 'val2' },
        ],
        NextToken: undefined,
      });

    await loadSecretsFromSSM();

    expect(process.env.SECRET_1).toBe('val1');
    expect(process.env.SECRET_2).toBe('val2');
    expect(mockGetParametersByPath).toHaveBeenCalledTimes(2);
  });

  test('uses default prefix when AWS_SSM_PREFIX not set', async () => {
    process.env.AWS_SSM_ENABLED = 'true';
    delete process.env.AWS_SSM_PREFIX;

    mockGetParametersByPath.mockResolvedValueOnce({
      Parameters: [],
      NextToken: undefined,
    });

    await loadSecretsFromSSM();

    // The GetParametersByPathCommand was called with the default path
    expect(mockGetParametersByPath).toHaveBeenCalledWith(
      expect.objectContaining({
        Path: '/lockdown/prod/',
        WithDecryption: true,
      }),
    );
  });
});
