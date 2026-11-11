import * as SecureStore from 'expo-secure-store';
import type { Store } from '../api/session';

const KEY = 'space.session.cookies';
const options = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

export const secureStore: Store = {
  get: () => SecureStore.getItemAsync(KEY, options),
  set: value => SecureStore.setItemAsync(KEY, value, options),
  clear: () => SecureStore.deleteItemAsync(KEY, options),
};
