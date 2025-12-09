import { createAppKit } from '@reown/appkit';
import { defineChain } from '@reown/appkit/networks';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { ref } from 'vue';

const modal = ref(null);
const isInitialized = ref(false);
const showWalletWarning = ref(false);

/**
 * Initialize AppKit with the provided network configuration.
 * @param {Object} config - The application config from useConfig
 * @param {Function} onAccountChange - Callback for account state changes
 * @returns {Promise<void>}
 */
async function initializeAppKit(config, onAccountChange) {
  if (isInitialized.value || !config?.network) return;

  const projectId = import.meta.env.VITE_REOWN_PROJECT_ID || '2f30532234e2903b2cf2505d144089ac';
  const chainId = config.network.evm.chainId;
  const rpcUrl = config.network.evm.rpc;
  const explorerUrl = config.network.evm.explorer || 'https://explorer.republicai.io';

  // Get token info from config
  const nativeToken = config.tokens?.[0] || { symbol: 'RAI', name: 'RAI', decimals: 18 };
  const networkName = config.blockchain?.name || 'Republic AI Devnet';

  const customNetwork = defineChain({
    id: chainId,
    caipNetworkId: `eip155:${chainId}`,
    chainNamespace: 'eip155',
    name: networkName,
    nativeCurrency: {
      decimals: nativeToken.decimals || 18,
      name: nativeToken.name || nativeToken.symbol,
      symbol: nativeToken.symbol,
    },
    rpcUrls: {
      default: {
        http: [rpcUrl],
      },
    },
    blockExplorers: {
      default: {
        name: 'Explorer',
        url: explorerUrl,
      },
    },
    testnet: true,
  });

  const metadata = {
    name: `${networkName} Faucet`,
    description: `Token distribution faucet for ${networkName}`,
    url: window.location.origin,
    icons: [`${window.location.origin}/favicon.svg`],
  };

  const wagmiAdapter = new WagmiAdapter({
    networks: [customNetwork],
    projectId,
    enableInjected: false,
    enableEIP6963: true,
  });

  try {
    // Check for multiple wallet providers
    if (window.ethereum?.providers && window.ethereum.providers.length > 1) {
      console.warn('Multiple wallet providers detected');
      showWalletWarning.value = true;
    }

    const appKitInstance = createAppKit({
      adapters: [wagmiAdapter],
      networks: [customNetwork],
      projectId,
      metadata,
      defaultNetwork: customNetwork,
      enableWalletGuide: true,
      enableReconnect: false,
      features: {
        analytics: false,
        email: false,
        socials: false,
        swaps: false,
        onramp: false,
      },
    });

    modal.value = appKitInstance;
    isInitialized.value = true;
    console.log('Wallet connector initialized');

    // Subscribe to account changes with debouncing
    if (modal.value && onAccountChange) {
      let updateTimeout = null;
      let lastAddress = null;

      const updateWalletState = (isConnected, address, chainId) => {
        clearTimeout(updateTimeout);
        updateTimeout = setTimeout(() => {
          if (isConnected && address) {
            if (address !== lastAddress) {
              console.log('EVM wallet connected:', address);
              lastAddress = address;
            }
            onAccountChange({ isConnected: true, address, chainId });
          } else {
            lastAddress = null;
            onAccountChange({ isConnected: false, address: null, chainId: null });
          }
        }, 100);
      };

      if (modal.value.subscribeAccount) {
        modal.value.subscribeAccount((account) => {
          updateWalletState(account.isConnected, account.address, account.chainId);
        });
      }

      // Check initial state after short delay
      setTimeout(() => {
        if (modal.value?.getAccount) {
          const account = modal.value.getAccount();
          if (account?.isConnected && account.address) {
            updateWalletState(true, account.address, account.chainId);
          }
        }
      }, 500);
    }
  } catch (error) {
    console.error('Failed to create AppKit modal:', error);
  }
}

/**
 * Open the AppKit wallet connection modal.
 */
function openModal() {
  if (modal.value?.open) {
    modal.value.open();
  }
}

/**
 * Disconnect from the current wallet.
 */
async function disconnect() {
  if (modal.value?.disconnect) {
    await modal.value.disconnect();
  }
}

/**
 * Composable for AppKit wallet connection functionality.
 */
export function useAppKit() {
  return {
    modal,
    isInitialized,
    showWalletWarning,
    initializeAppKit,
    openModal,
    disconnect,
  };
}
