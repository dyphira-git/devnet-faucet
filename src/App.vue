<template>
  <div id="app" class="bg-black min-h-screen">
    <Toaster position="top-right" :theme="'dark'" richColors />
    <Header />
    <div class="mx-auto max-w-7xl px-3 sm:px-4 md:px-6 lg:px-8">
      <h1 class="font-semibold text-center text-4xl sm:text-5xl md:text-6xl lg:text-7xl xl:text-[80px] leading-[1.1] tracking-[-0.05em] mb-8 sm:mb-10 md:mb-12 mt-6 sm:mt-8 bg-[linear-gradient(260.47deg,#B4B4B4_48.52%,#FFFFFF_79.81%)] bg-clip-text text-transparent [-webkit-background-clip:text] [-webkit-text-fill-color:transparent] [text-shadow:0px_2px_3px_rgba(255,255,255,0.75)_inset,0px_1px_1px_rgba(255,255,255,1)_inset] px-2">
        RAI FAUCET
      </h1>
      <!-- Wallet conflict warning -->
      <div v-if="showWalletWarning" class="alert alert-warning alert-dismissible fade show mb-4 sm:mb-6 mx-2 sm:mx-0" role="alert">
        <i class="fas fa-exclamation-triangle"></i>
        <strong>Multiple Wallet Extensions Detected</strong>
        <p class="mb-2 mt-2">You have multiple wallet extensions installed which may cause connection issues.</p>
        <p class="mb-0">For best results, disable all wallet extensions except the one you want to use (e.g., MetaMask).</p>
        <button type="button" class="btn-close" @click="dismissWarning" aria-label="Close"></button>
      </div>
      <Tabs />

      <div class="w-full max-w-7xl mx-auto px-2 sm:px-4 md:px-6 lg:px-8 py-8 sm:py-10 md:py-12 lg:py-16 xl:py-20">
        <div class="w-full max-w-6xl mx-auto">
          <DividerLine class="w-full h-auto" />
        </div>
      </div>

      <FAQs />
    </div>
    <Footer />
  </div>
</template>

<script setup>
import { onMounted, provide } from 'vue';
import { Toaster } from 'vue-sonner';
import FAQs from './components/FAQs.vue';
import Footer from './components/Footer.vue';
import Header from './components/Header.vue';
import Tabs from './components/Tabs.vue';
import { useAppKit } from './composables/useAppKit';
import { useConfig } from './composables/useConfig';
import { useWalletStore } from './composables/useWalletStore';
import DividerLine from './svg/DividerLine.vue';

const { config, loadConfig } = useConfig();
const walletStore = useWalletStore();
const { modal, showWalletWarning, initializeAppKit, openModal, disconnect } = useAppKit();

// Provide wallet functions to child components
provide('appKitModal', modal);
provide('openAppKitModal', openModal);
provide('disconnectAppKit', disconnect);

const dismissWarning = () => {
  showWalletWarning.value = false;
};

onMounted(async () => {
  try {
    await loadConfig();
    if (config.value?.network) {
      console.log('Faucet configured for network:', config.value.network.evm.chainId);
    }
  } catch (error) {
    console.error('Failed to load config:', error);
    return;
  }

  if (config.value?.network) {
    await initializeAppKit(config.value, (account) => {
      if (account.isConnected) {
        walletStore.evmWallet.connected = true;
        walletStore.evmWallet.address = account.address;
        walletStore.evmWallet.chainId = account.chainId;
      } else {
        walletStore.evmWallet.connected = false;
        walletStore.evmWallet.address = null;
        walletStore.evmWallet.chainId = null;
      }
    });
  }
});
</script>

<style scoped>
/* Multiple wallet warning */
.alert-warning {
  background: rgba(255, 193, 7, 0.1);
  border: 2px solid #ffc107;
  color: var(--text-primary);
}

.alert-warning .alert-heading {
  color: #ffc107;
}

.alert-warning .btn-close {
  filter: invert(0.8);
}

/* Mobile responsive container */
@media (max-width: 768px) {
  .container {
    padding-left: 1rem;
    padding-right: 1rem;
  }

  .alert {
    font-size: 0.9rem;
    padding: 0.75rem 1rem;
  }

  .alert-heading {
    font-size: 1rem;
  }
}

@media (max-width: 480px) {
  .container {
    padding-left: 0.75rem;
    padding-right: 0.75rem;
  }

  .alert {
    font-size: 0.85rem;
    padding: 0.65rem 0.85rem;
  }

  .alert p {
    margin-bottom: 0.5rem !important;
  }
}
</style>
