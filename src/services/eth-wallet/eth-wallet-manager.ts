import ethChains from 'constants/eth-chains';
import dotenv from 'dotenv';
import _ from 'lodash';
import Web3Manager from 'services/eth-wallet/web3-manager';
import loggerFactory from 'services/util/logger-factory';
import typeHelper from 'services/util/type-helper';
import accountStore from 'stores/account-store';
import {
  AccountChangeEventHandler,
  EthWalletType,
  IERC20Token,
  IEthWallet,
  IEthWalletManager,
  NetworkChangeEventHandler,
  NoMetaMaskWalletError,
  SupportedEthChain,
} from 'types';

import MetaMaskWallet from './meta-mask-wallet';
import CosmostationWallet from './cosmostation-wallet';

dotenv.config();
const logger = loggerFactory.getLogger('[EthWalletManager]');

const walletMap: Record<EthWalletType, IEthWallet> = {
  [EthWalletType.MetaMask]: new MetaMaskWallet(),
  [EthWalletType.Cosmostation]: new CosmostationWallet()
};

const chainWalletTypeMap: Record<SupportedEthChain, EthWalletType | undefined> = {
  [SupportedEthChain.Eth]: undefined
};

const chinWalletMap: Record<SupportedEthChain, IEthWallet | undefined> = {
  [SupportedEthChain.Eth]: undefined
};

async function init (ethChain: SupportedEthChain): Promise<void> {
  const duplicated: Record<string, SupportedEthChain[]> = {};
  for (const chain of _.values(SupportedEthChain)) {
    const walletType = window.localStorage.getItem(chain.toString());
    if (walletType && typeHelper.isEthWalletType(walletType)) {
      if (walletMap[walletType].isSupportMultiConnection()) {
        try {
          await connect(chain as SupportedEthChain, walletType);
        } catch (error) {
          logger.error(`[init] Error on chain: ${chain} and wallet type: ${walletType}`, error);
        }
      } else {
        const _walletType = EthWalletType[walletType];
        if (!duplicated[_walletType]) {
          duplicated[_walletType] = [];
        }
        duplicated[_walletType].push(chain);
      }
    }
  }

  for (const _walletType in duplicated) {
    const chains = duplicated[_walletType];
    const walletType = (<any>EthWalletType)[_walletType];
    if (_.includes(chains, ethChain)) {
      try {
        await connect(ethChain, walletType);
      } catch (error) {
        logger.error(`[init] Error on chain: ${ethChain} and wallet type: ${walletType}`, error);
      }
    } else {
      try {
        const chain = _.first(chains);
        if (chain) {
          await connect(chain, walletType);
        }
      } catch (error) {
        logger.error(`[init] Error on chain: ${ethChain} and wallet type: ${walletType}`, error);
      }
    }
  }
}

async function connect (chain: SupportedEthChain, walletType: EthWalletType): Promise<void> {
  const wallet = getWallet(walletType);
  if (!wallet) {
    logger.info('[connect] No wallet for wallet type: ', walletType);
    // TODO: Make general error type
    throw new NoMetaMaskWalletError();
  }

  logger.info(`[connect] Connecting ${walletType} for ${chain}...`);
  setWallet(chain, walletType);

  await wallet.connect(chain);
  const account = await wallet.getAccount();
  if (account) {
    logger.info('[connect] Account:', account);
    accountStore.updateAccount(chain, account, walletType);
    registerEventHandlers(chain);
  }
}

async function disconnect (chain: SupportedEthChain): Promise<void> {
  logger.info(`[Disconnect] Disconnecting for ${chain}...`);
  unsetWallet(chain);
  accountStore.updateAccount(chain, undefined, undefined);
}

function registerEventHandlers (chain: SupportedEthChain): void {
  try {
    logger.info(`[registerEventHandler] Registering event handlers for ${chain}...`);
    const wallet = getWalletByChain(chain);
    if (wallet) {
      logger.info(`[registerEventHandler] Registering event handlers for ${wallet.type}...`);
      const accountChangeEventHandler = getAccountChangeEventHandler(chain, wallet);
      wallet.registerAccountChangeHandler(accountChangeEventHandler);

      const networkChangeEventHandler = getNetworkChangeEventHandler(chain, wallet);
      wallet.registerNetworkChangeHandler(networkChangeEventHandler);
    }
  } catch (error) {
    logger.error(error);
  }
}

function getAccountChangeEventHandler (chain: SupportedEthChain, wallet: IEthWallet): AccountChangeEventHandler {
  return async (accounts: string[]): Promise<void> => {
    logger.info('[accountChangeEventHandler] Chain:', chain);
    logger.info('[accountChangeEventHandler] Updated accounts:', accounts);
    if ((!_.isEmpty(accounts) && wallet.type === 'MetaMask') || wallet.type === 'Cosmostation') {
      const account = await wallet.getAccount();
      accountStore.updateAccount(chain, account, undefined);
    } else {
      accountStore.updateAccount(chain, undefined, undefined);
    }
  };
}

function getNetworkChangeEventHandler (chain: SupportedEthChain, wallet: IEthWallet): NetworkChangeEventHandler {
  const chainInfo = ethChains[chain];
  return async (chainId: string): Promise<void> => {
    logger.info('[networkChangeEventHandler] Chain:', chain);
    logger.info('[networkChangeEventHandler] Updated chain ID:', chainId);
    if (chainId !== chainInfo.chainId) {
      accountStore.updateAccount(chain, undefined, undefined);
    } else {
      const account = await wallet.getAccount();
      accountStore.updateAccount(chain, account, undefined);
    }
  };
}

async function getERC20Info (chain: SupportedEthChain, contractAddress: string): Promise<IERC20Token | null> {
  try {
    logger.info('[getERC20Info] Getting ERC20 token info...', contractAddress);
    const wallet = getWalletByChain(chain);
    if (wallet) {
      await wallet.updateNetwork(chain);
      const web3 = await wallet.getWeb3();
      if (web3 !== null) {
        return web3.getERC20Info(contractAddress);
      }
    }
    return null;
  } catch (error) {
    logger.error(error);
    return null;
  }
}

async function updateAccount (chain: SupportedEthChain): Promise<void> {
  try {
    logger.info('[updateAccount] Updating account...');
    const wallet = getWalletByChain(chain);
    if (wallet) {
      await wallet.updateNetwork(chain);
      const account = await wallet.getAccount();
      accountStore.updateAccount(chain, account, undefined);
    }
  } catch (error) {
    logger.error(error);
  }
}

async function getERC20Balance (chain: SupportedEthChain, contractAddress: string, ownerAddress: string): Promise<string> {
  try {
    logger.info('[getERC20Balance] Getting ERC20 token balance...', 'contract address:', contractAddress, 'owner address:', ownerAddress);
    const wallet = getWalletByChain(chain);
    if (wallet) {
      await wallet.updateNetwork(chain);
      const web3 = await wallet.getWeb3();
      if (web3 !== null) {
        return web3.getERC20Balance(contractAddress, ownerAddress);
      }
    }
    return '0';
  } catch (error) {
    logger.error(error);
    return '0';
  }
}

async function getWeb3 (chain: SupportedEthChain): Promise<Web3Manager | null> {
  const wallet = getWalletByChain(chain);
  if (wallet !== undefined) {
    return wallet.getWeb3();
  } else {
    return null;
  }
}

function getWallet (walletType: EthWalletType): IEthWallet {
  return walletMap[walletType];
}

function getWalletByChain (chain: SupportedEthChain): IEthWallet | undefined {
  const type = chainWalletTypeMap[chain];
  if (type) {
    return getWallet(type);
  } else {
    return undefined;
  }
}

function setWallet (chain: SupportedEthChain, walletType: EthWalletType): void {
  const wallet = getWallet(walletType);
  chainWalletTypeMap[chain] = walletType;
  chinWalletMap[chain] = wallet;
  window.localStorage.setItem(chain, walletType);
}

function unsetWallet (chain: SupportedEthChain): void {
  chainWalletTypeMap[chain] = undefined;
  chinWalletMap[chain] = undefined;
  window.localStorage.setItem(chain, '');
}

const manager: IEthWalletManager = {
  init,
  connect,
  disconnect,
  updateAccount,
  getERC20Info,
  getERC20Balance,
  getWeb3
};

export default manager;
