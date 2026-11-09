import { createAuthClient } from 'better-auth/react';
import { authFetch } from '../../shared/api/session-fetch.js';
export const authClient = createAuthClient({ basePath: '/v1/auth', fetchOptions: { customFetchImpl: authFetch } });
