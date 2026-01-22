import 'dotenv/config';
import { toBase64 } from '@cosmjs/encoding';
import { makeAuthInfoBytes, makeSignDoc } from '@cosmjs/proto-signing';
import { accountFromAny } from '@cosmjs/stargate';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bech32 } from 'bech32';
import cors from 'cors';
import { MsgSend } from 'cosmjs-types/cosmos/bank/v1beta1/tx.js';
import { SignDoc, TxBody, TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx.js';
import { Any } from 'cosmjs-types/google/protobuf/any.js';
import { JsonRpcProvider, Wallet } from 'ethers';
import express from 'express';
import Long from 'long';
import conf, {
  getCosmosAddress,
  getEvmAddress,
  getPrivateKey,
  getPrivateKeyBytes,
  getPublicKeyBytes,
  initializeSecureKeys,
} from './config.js';
import logRotation from './src/logRotation.js';

const app = express();
const chainConf = conf.blockchain;

// Constants
const API_TIMEOUT_MS = 5000;
const EVM_ADDRESS_LENGTH = 42;
const LOW_BALANCE_THRESHOLD_PERCENT = 10; // Alert when faucet balance falls below 10% of distribution amount

// API Key for authentication (required for /send endpoint)
const FAUCET_API_KEY = process.env.FAUCET_API_KEY;
if (!FAUCET_API_KEY) {
  console.error('[FATAL] FAUCET_API_KEY environment variable is required');
  process.exit(1);
}

// CORS configuration - restricted to points-webapp domains only
const corsOptions = {
  origin: (origin, callback) => {
    const allowedOrigins = [
      'https://points.republicai.io',
      'https://staging.points.republicai.io',
      'http://localhost:3000',
    ];

    // Allow requests with no origin (server-to-server calls)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    if (process.env.NODE_ENV === 'development') return callback(null, true);

    // Allow localhost in development
    if (origin.startsWith('http://localhost:') || origin.startsWith('https://localhost:')) {
      return callback(null, true);
    }

    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
  credentials: true,
};

/**
 * API Key authentication middleware.
 * Requires X-API-Key header to match FAUCET_API_KEY.
 */
function requireApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'API key required',
    });
  }

  if (apiKey !== FAUCET_API_KEY) {
    return res.status(403).json({
      success: false,
      error: 'Forbidden',
      message: 'Invalid API key',
    });
  }

  next();
}

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Detect address type (cosmos bech32 or EVM hex)
function detectAddressType(address) {
  if (!address) return 'unknown';

  // EVM hex address
  if (address.startsWith('0x') && address.length === EVM_ADDRESS_LENGTH) {
    const valid = /^0x[a-fA-F0-9]{40}$/.test(address);
    return valid ? 'evm' : 'unknown';
  }

  // Cosmos bech32 address
  if (address.startsWith(conf.blockchain.sender.option.prefix)) {
    try {
      bech32.decode(address);
      return 'cosmos';
    } catch {
      return 'unknown';
    }
  }

  return 'unknown';
}

// Convert hex address to Cosmos bech32
function hexToCosmosAddress(hexAddress) {
  try {
    const addressBytes = Buffer.from(hexAddress.slice(2), 'hex');
    const words = bech32.toWords(addressBytes);
    return bech32.encode(conf.blockchain.sender.option.prefix, words);
  } catch (error) {
    console.error('Error converting hex to cosmos address:', error);
    return null;
  }
}

// Convert Cosmos bech32 to hex
function cosmosAddressToHex(cosmosAddress) {
  try {
    const { words } = bech32.decode(cosmosAddress);
    const addressBytes = Buffer.from(bech32.fromWords(words));
    return `0x${addressBytes.toString('hex')}`;
  } catch (error) {
    console.error('Error converting cosmos to hex address:', error);
    return null;
  }
}

// Get the alternate address format (EVM <-> Cosmos)
function getAlternateAddress(address, type) {
  if (type === 'evm') {
    return hexToCosmosAddress(address);
  }
  return cosmosAddressToHex(address);
}

// Get balance via EVM RPC
async function getEvmBalance(address) {
  try {
    const ethProvider = new JsonRpcProvider(chainConf.endpoints.evm_endpoint);
    const balance = await ethProvider.getBalance(address);
    return BigInt(balance.toString());
  } catch (error) {
    console.error('Error getting EVM balance:', error);
    return null;
  }
}

/**
 * Fetch all Cosmos balances for an address with timeout handling.
 * @param {string} address - Cosmos bech32 address
 * @returns {Promise<Array|null>} Array of balance objects or null on error
 */
async function fetchCosmosBalances(address) {
  const restEndpoint = chainConf.endpoints.rest_endpoint;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const response = await fetch(`${restEndpoint}/cosmos/bank/v1beta1/balances/${address}`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    return data.balances && Array.isArray(data.balances) ? data.balances : [];
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      console.error('Cosmos balance request timed out');
    } else {
      console.error('Error fetching Cosmos balances:', error);
    }
    return null;
  }
}

/**
 * Get native token balance via Cosmos REST (for threshold checking).
 * @param {string} address - Cosmos bech32 address
 * @returns {Promise<BigInt|null>} Balance as BigInt or null on error
 */
async function getCosmosBalance(address) {
  const balances = await fetchCosmosBalances(address);
  if (!balances) return null;

  const tokenBalance = balances.find((b) => b.denom === chainConf.tx.amounts[0]?.denom);
  return BigInt(tokenBalance?.amount || '0');
}

// Get recipient balance checking both address formats (same underlying account)
async function getRecipientBalance(address, type) {
  const alternateAddress = getAlternateAddress(address, type);

  // Query both EVM and Cosmos endpoints since they share the same account
  // Take the maximum to handle indexing lag or query failures
  let evmBalance = BigInt(0);
  let cosmosBalance = BigInt(0);

  const evmAddr = type === 'evm' ? address : alternateAddress;
  const cosmosAddr = type === 'cosmos' ? address : alternateAddress;

  // Query both in parallel
  const [evmResult, cosmosResult] = await Promise.all([
    evmAddr ? getEvmBalance(evmAddr) : Promise.resolve(null),
    cosmosAddr ? getCosmosBalance(cosmosAddr) : Promise.resolve(null),
  ]);

  evmBalance = evmResult ?? BigInt(0);
  cosmosBalance = cosmosResult ?? BigInt(0);

  // Use the higher balance (both should be same, but handles indexing lag)
  const balance = evmBalance > cosmosBalance ? evmBalance : cosmosBalance;

  console.log(
    `Balance check - EVM (${evmAddr}): ${evmBalance}, Cosmos (${cosmosAddr}): ${cosmosBalance}, Using: ${balance}`
  );

  return balance;
}

// Get account info from REST API
async function getAccountInfo(address) {
  try {
    const restEndpoint = chainConf.endpoints.rest_endpoint;
    const response = await fetch(`${restEndpoint}/cosmos/auth/v1beta1/accounts/${address}`);

    if (!response.ok) {
      if (response.status === 404) {
        console.log('Account not found, using default values');
        return { accountNumber: 0, sequence: 0 };
      }
      throw new Error(`Failed to get account info: ${response.statusText}`);
    }

    const data = await response.json();

    if (data.account?.['@type']) {
      let accountInfo;

      if (data.account['@type'].includes('EthAccount')) {
        accountInfo = {
          accountNumber: Number.parseInt(data.account.base_account?.account_number || '0', 10),
          sequence: Number.parseInt(data.account.base_account?.sequence || '0', 10),
        };
      } else if (data.account['@type'].includes('BaseAccount')) {
        accountInfo = {
          accountNumber: Number.parseInt(data.account.account_number || '0', 10),
          sequence: Number.parseInt(data.account.sequence || '0', 10),
        };
      } else {
        try {
          const account = accountFromAny(data.account);
          accountInfo = { accountNumber: account.accountNumber, sequence: account.sequence };
        } catch {
          accountInfo = {
            accountNumber: Number.parseInt(
              data.account.account_number || data.account.base_account?.account_number || '0',
              10
            ),
            sequence: Number.parseInt(
              data.account.sequence || data.account.base_account?.sequence || '0',
              10
            ),
          };
        }
      }

      console.log('Account info parsed:', accountInfo);
      return accountInfo;
    }

    return { accountNumber: 0, sequence: 0 };
  } catch (error) {
    console.error('Error getting account info:', error);
    return { accountNumber: 0, sequence: 0 };
  }
}

// Create Cosmos transaction
async function createCosmosTransaction(
  fromAddress,
  toAddress,
  amounts,
  sequence,
  accountNumber,
  chainId
) {
  try {
    const msg = {
      typeUrl: '/cosmos.bank.v1beta1.MsgSend',
      value: MsgSend.fromPartial({
        fromAddress: fromAddress,
        toAddress: toAddress,
        amount: amounts,
      }),
    };

    const txBody = TxBody.fromPartial({
      messages: [
        Any.fromPartial({
          typeUrl: msg.typeUrl,
          value: MsgSend.encode(msg.value).finish(),
        }),
      ],
      memo: '',
    });

    const feeAmount = [
      {
        denom: chainConf.tx.fee.cosmos.amount[0].denom,
        amount: chainConf.tx.fee.cosmos.amount[0].amount,
      },
    ];

    const gasLimit = Long.fromString(chainConf.tx.fee.cosmos.gas);

    const pubkeyBytes = getPublicKeyBytes();
    const fieldTag = (1 << 3) | 2;
    const pubkeyProto = Buffer.concat([
      Buffer.from([fieldTag]),
      Buffer.from([pubkeyBytes.length]),
      pubkeyBytes,
    ]);

    const pubkey = Any.fromPartial({
      typeUrl: '/cosmos.evm.crypto.v1.ethsecp256k1.PubKey',
      value: pubkeyProto,
    });

    const authInfo = makeAuthInfoBytes(
      [{ pubkey, sequence: Long.fromNumber(sequence) }],
      feeAmount,
      gasLimit,
      undefined,
      undefined
    );

    const signDoc = makeSignDoc(
      TxBody.encode(txBody).finish(),
      authInfo,
      chainId,
      Long.fromNumber(accountNumber)
    );

    return { txBody, authInfo, signDoc };
  } catch (error) {
    console.error('Error creating Cosmos transaction:', error);
    throw error;
  }
}

// Config endpoint for web app
app.get('/config.json', (_req, res) => {
  res.json({
    project: conf.project,
    blockchain: {
      name: chainConf.name,
      endpoints: chainConf.endpoints,
      ids: chainConf.ids,
      sender: { option: { prefix: chainConf.sender.option.prefix } },
      balanceThreshold: chainConf.balanceThreshold,
    },
    tokens: chainConf.tx.amounts.map((token) => ({
      denom: token.denom,
      symbol: token.symbol || token.denom.toUpperCase(),
      name: token.name || token.denom,
      amount: token.amount,
      decimals: token.decimals,
      display_denom: token.display_denom || token.denom,
    })),
    sample: {
      cosmos: `${chainConf.sender.option.prefix}1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqnrql8a`,
      evm: '0x0000000000000000000000000000000000000001',
    },
    network: {
      name: chainConf.name,
      faucetAddresses: {
        cosmos: getCosmosAddress(),
        evm: getEvmAddress(),
      },
      evm: {
        chainId: chainConf.ids.chainId,
        chainIdHex: `0x${chainConf.ids.chainId.toString(16)}`,
        rpc: chainConf.endpoints.evm_endpoint,
        websocket: chainConf.endpoints.evm_websocket || '',
        explorer: chainConf.endpoints.evm_explorer,
      },
      cosmos: {
        chainId: chainConf.ids.cosmosChainId,
        rpc: chainConf.endpoints.rpc_endpoint,
        rest: chainConf.endpoints.rest_endpoint,
        prefix: chainConf.sender.option.prefix,
        explorer: chainConf.endpoints.cosmos_explorer,
      },
    },
  });
});

// Balance endpoint
app.get('/balance/:type', async (req, res) => {
  const type = req.params.type;
  const { address } = req.query;

  console.log(`[BALANCE] Request - Type: ${type}, Address: ${address || 'faucet wallet'}`);

  const balances = [];

  try {
    if (type === 'evm') {
      const targetAddress = address?.startsWith('0x') ? address : getEvmAddress();
      const ethProvider = new JsonRpcProvider(chainConf.endpoints.evm_endpoint);

      const nativeBalance = await ethProvider.getBalance(targetAddress);
      balances.push({
        denom: chainConf.tx.amounts[0]?.denom || 'native',
        amount: nativeBalance.toString(),
        type: 'native',
        decimals: 18,
      });
    } else if (type === 'cosmos') {
      const targetAddress = address?.startsWith(chainConf.sender.option.prefix)
        ? address
        : getCosmosAddress();

      const cosmosBalances = await fetchCosmosBalances(targetAddress);
      if (cosmosBalances) {
        for (const balance of cosmosBalances) {
          const token = chainConf.tx.amounts.find((t) => t.denom === balance.denom);
          balances.push({
            denom: balance.denom,
            amount: balance.amount,
            type: 'native',
            decimals: token?.decimals || 6,
          });
        }
      }
    }
  } catch (err) {
    console.error('Balance fetch error:', err);
  }

  res.send({ balances, type });
});

// Main faucet endpoint (requires API key authentication)
// Accepts optional ?amount= query parameter for role-based token amounts
app.get('/send/:address', requireApiKey, async (req, res) => {
  const { address } = req.params;
  const { amount: requestedAmount } = req.query;

  console.log(
    `[FAUCET] Token request - Address: ${address}, Requested amount: ${requestedAmount || 'default'}`
  );

  if (!address) {
    return res.status(400).json({
      status: 'error',
      error: 'Address is required',
      message: 'Address is required',
    });
  }

  const addressType = detectAddressType(address);

  if (addressType === 'unknown') {
    return res.status(400).json({
      status: 'error',
      error: 'InvalidAddress',
      message: `Address [${address}] is not supported. Must be a valid ${conf.blockchain.sender.option.prefix} address or hex address (0x...)`,
    });
  }

  try {
    // Check recipient balance
    const recipientBalance = await getRecipientBalance(address, addressType);
    const threshold = BigInt(chainConf.balanceThreshold);
    const tokenSymbol = chainConf.tx.amounts[0]?.symbol || 'tokens';
    const decimals = chainConf.tx.amounts[0]?.decimals || 18;

    // Determine amount to send:
    // 1. If requestedAmount is provided, use it (capped by threshold - balance)
    // 2. Otherwise, top up to threshold
    let sendAmount;

    if (requestedAmount) {
      // Use requested amount from points-webapp (role-based)
      const requested = BigInt(requestedAmount);
      const maxAllowed = threshold - recipientBalance;

      // Cap at threshold to prevent over-funding
      sendAmount = requested > maxAllowed ? maxAllowed : requested;

      if (sendAmount <= BigInt(0)) {
        const balanceFormatted = (Number(recipientBalance) / 10 ** decimals).toFixed(4);
        const thresholdFormatted = (Number(threshold) / 10 ** decimals).toFixed(0);

        return res.status(400).json({
          status: 'error',
          error: 'BalanceThresholdExceeded',
          message: `Address already has ${balanceFormatted} ${tokenSymbol}. Faucet only tops up wallets below ${thresholdFormatted} ${tokenSymbol}.`,
          balance: {
            before: recipientBalance.toString(),
            after: recipientBalance.toString(),
          },
        });
      }
    } else {
      // Default behavior: top up to threshold
      if (recipientBalance >= threshold) {
        const balanceFormatted = (Number(recipientBalance) / 10 ** decimals).toFixed(4);
        const thresholdFormatted = (Number(threshold) / 10 ** decimals).toFixed(0);

        return res.status(400).json({
          status: 'error',
          error: 'BalanceThresholdExceeded',
          message: `Address already has ${balanceFormatted} ${tokenSymbol}. Faucet only tops up wallets below ${thresholdFormatted} ${tokenSymbol}.`,
          balance: {
            before: recipientBalance.toString(),
            after: recipientBalance.toString(),
          },
        });
      }
      sendAmount = threshold - recipientBalance;
    }

    const sendFormatted = (Number(sendAmount) / 10 ** decimals).toFixed(4);
    const balanceFormatted = (Number(recipientBalance) / 10 ** decimals).toFixed(4);

    console.log(
      `Processing faucet request for ${address} (type: ${addressType})`,
      `- Current balance: ${balanceFormatted} ${tokenSymbol}`,
      `- Send amount: ${sendFormatted} ${tokenSymbol}`
    );

    let txResult;

    if (addressType === 'evm') {
      txResult = await sendEvmNativeTokens(address, sendAmount);
    } else {
      txResult = await sendCosmosNativeTokens(address, sendAmount);
    }

    // Calculate new balance (approximate)
    const newBalance = recipientBalance + sendAmount;

    res.json({
      status: 'success',
      message: 'Tokens sent successfully!',
      txHash: txResult.transaction_hash,
      amount: txResult.amount,
      balance: {
        before: recipientBalance.toString(),
        after: newBalance.toString(),
      },
    });

    // Check balance after successful send (async, non-blocking)
    checkFaucetBalanceAlert().catch(() => {
      /* intentionally swallowed */
    });
  } catch (error) {
    console.error('Faucet error:', error);
    res.status(500).json({
      status: 'error',
      error: 'TransactionFailed',
      message: error.message || 'Transaction failed',
    });
  }
});

// Send native tokens via EVM (like ETH on Ethereum)
async function sendEvmNativeTokens(recipientAddress, amount) {
  console.log('Sending native tokens via EVM to:', recipientAddress);

  const ethProvider = new JsonRpcProvider(chainConf.endpoints.evm_endpoint);
  const privateKey = getPrivateKey();
  const wallet = new Wallet(privateKey, ethProvider);

  // Estimate gas cost to reserve from faucet balance
  const feeData = await ethProvider.getFeeData();
  const gasLimit = BigInt(chainConf.tx.fee.evm.gasLimit || '21000');
  const gasPrice = feeData.gasPrice || BigInt(chainConf.tx.fee.evm.gasPrice || '20000000000');
  const estimatedGasCost = gasLimit * gasPrice;

  const faucetBalance = await ethProvider.getBalance(wallet.address);
  console.log(`Faucet balance: ${faucetBalance.toString()} wei`);
  console.log(`Estimated gas cost: ${estimatedGasCost.toString()} wei`);

  // Calculate max sendable amount (balance minus gas reserve)
  const maxSendable =
    faucetBalance > estimatedGasCost ? faucetBalance - estimatedGasCost : BigInt(0);

  // Use the smaller of requested amount or max sendable
  let sendAmount = BigInt(amount);
  if (sendAmount > maxSendable) {
    console.log(`Capping send amount from ${sendAmount} to ${maxSendable} (reserving gas)`);
    sendAmount = maxSendable;
  }

  console.log(`Sending amount: ${sendAmount.toString()} wei`);

  if (sendAmount <= BigInt(0)) {
    throw new Error(
      `Insufficient faucet balance. Has ${faucetBalance.toString()} wei, needs gas reserve of ${estimatedGasCost.toString()} wei`
    );
  }

  const tx = await wallet.sendTransaction({
    to: recipientAddress,
    value: sendAmount,
  });

  console.log('Transaction sent:', tx.hash);
  const receipt = await tx.wait();
  console.log('Transaction confirmed!');

  return {
    network_type: 'evm',
    transaction_hash: receipt.hash,
    block_number: receipt.blockNumber,
    gas_used: receipt.gasUsed?.toString() || '0',
    from_address: receipt.from,
    to_address: receipt.to,
    amount: sendAmount.toString(),
    explorer_url: `${chainConf.endpoints.evm_explorer}/tx/${receipt.hash}`,
  };
}

// Send native tokens via Cosmos
async function sendCosmosNativeTokens(recipientAddress, topUpAmount) {
  console.log('Sending native tokens via Cosmos to:', recipientAddress);

  const fromAddress = getCosmosAddress();
  const accountInfo = await getAccountInfo(fromAddress);

  // Use the calculated top-up amount for the native token
  const amounts = [
    {
      denom: chainConf.tx.amounts[0].denom,
      amount: topUpAmount.toString(),
    },
  ];

  console.log('Amounts to send:', amounts);

  const { txBody, authInfo, signDoc } = await createCosmosTransaction(
    fromAddress,
    recipientAddress,
    amounts,
    accountInfo.sequence,
    accountInfo.accountNumber,
    chainConf.ids.cosmosChainId
  );

  // Sign with eth_secp256k1 (Keccak256 hash)
  const privateKeyBytes = getPrivateKeyBytes();
  const signBytes = SignDoc.encode(signDoc).finish();
  const hashedMessage = Buffer.from(keccak_256(signBytes));

  const signatureResult = secp256k1.sign(hashedMessage, privateKeyBytes);
  const signatureBytes = Buffer.concat([
    Buffer.from(signatureResult.r.toString(16).padStart(64, '0'), 'hex'),
    Buffer.from(signatureResult.s.toString(16).padStart(64, '0'), 'hex'),
  ]);

  const txRaw = TxRaw.fromPartial({
    bodyBytes: TxBody.encode(txBody).finish(),
    authInfoBytes: authInfo,
    signatures: [signatureBytes],
  });

  const txBytes = TxRaw.encode(txRaw).finish();
  const txBase64 = toBase64(txBytes);

  // Broadcast
  const broadcastUrl = `${chainConf.endpoints.rest_endpoint}/cosmos/tx/v1beta1/txs`;
  const broadcastResponse = await fetch(broadcastUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tx_bytes: txBase64, mode: 'BROADCAST_MODE_SYNC' }),
  });

  if (!broadcastResponse.ok) {
    const errorData = await broadcastResponse.json();
    throw new Error(`Broadcast failed: ${JSON.stringify(errorData)}`);
  }

  const broadcastResult = await broadcastResponse.json();

  if (broadcastResult.tx_response && broadcastResult.tx_response.code !== 0) {
    throw new Error(
      `Transaction failed: ${broadcastResult.tx_response.raw_log || broadcastResult.tx_response.log}`
    );
  }

  const txHash = broadcastResult.tx_response.txhash;

  return {
    network_type: 'cosmos',
    transaction_hash: txHash,
    height: broadcastResult.tx_response.height || '0',
    gas_used: broadcastResult.tx_response.gas_used || '0',
    gas_wanted: broadcastResult.tx_response.gas_wanted || '0',
    amount: topUpAmount.toString(),
    explorer_url: `${chainConf.endpoints.cosmos_explorer}/tx/${txHash}`,
  };
}

// Test endpoint
app.get('/test', (_req, res) => {
  res.send({
    status: 'ok',
    evmAddress: getEvmAddress(),
    cosmosAddress: getCosmosAddress(),
  });
});

// Health check
app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Initialize faucet
async function initializeFaucet() {
  console.log('[START] Faucet initializing...');

  await initializeSecureKeys();
  console.log(' SecureKeyManager initialized');
  console.log(` EVM Address: ${getEvmAddress()}`);
  console.log(` Cosmos Address: ${getCosmosAddress()}`);

  logRotation.registerLogFile('server.log', {
    maxSize: 5 * 1024 * 1024,
    maxFiles: 3,
    compress: false,
  });

  // Check balance on startup
  await checkFaucetBalanceAlert();

  console.log(' Faucet server ready!');
}

/**
 * Check faucet balance and log alert if below threshold.
 * Designed for external log aggregation/alerting systems.
 */
async function checkFaucetBalanceAlert() {
  try {
    const distributionAmount = BigInt(chainConf.tx.amounts[0]?.amount || '10000000000000000000');
    const alertThreshold =
      (distributionAmount * BigInt(LOW_BALANCE_THRESHOLD_PERCENT)) / BigInt(100);
    const tokenSymbol = chainConf.tx.amounts[0]?.symbol || 'tokens';
    const decimals = chainConf.tx.amounts[0]?.decimals || 18;

    // Check EVM balance
    const ethProvider = new JsonRpcProvider(chainConf.endpoints.evm_endpoint);
    const evmBalance = await ethProvider.getBalance(getEvmAddress());

    if (evmBalance < alertThreshold) {
      const balanceFormatted = (Number(evmBalance) / 10 ** decimals).toFixed(4);
      const thresholdFormatted = (Number(alertThreshold) / 10 ** decimals).toFixed(4);
      console.error(
        `[ALERT] LOW_FAUCET_BALANCE: EVM balance ${balanceFormatted} ${tokenSymbol} is below threshold ${thresholdFormatted} ${tokenSymbol}. ` +
          `Address: ${getEvmAddress()}`
      );
    }
  } catch (error) {
    console.error('[ALERT] BALANCE_CHECK_FAILED: Unable to check faucet balance:', error.message);
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n Shutting down faucet...');
  logRotation.stopAll();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n Shutting down faucet...');
  logRotation.stopAll();
  process.exit(0);
});

// Error handling middleware
app.use((err, _req, res, _next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler for unknown routes
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Start server
const HOST = process.env.HOST || '0.0.0.0';
app.listen(conf.port, HOST, async () => {
  console.log(`[START] Faucet server starting on ${HOST}:${conf.port}...`);
  await initializeFaucet();
  console.log(` Server listening on http://${HOST}:${conf.port}`);
});
