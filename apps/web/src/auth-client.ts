export interface CurrentUser {
  id: string;
  username: string;
  email: string;
  createdAt: string;
  role?: 'user' | 'admin';
  accountStatus?: 'active' | 'suspended';
}

type AuthPayload = { user: CurrentUser | null };
let currentRequest: Promise<AuthPayload> | null = null;

export function currentUser(): Promise<AuthPayload> {
  currentRequest ??= fetch('/api/auth/me')
    .then(async (response) => {
      if (!response.ok) throw new Error('authentication unavailable');
      return response.json() as Promise<AuthPayload>;
    })
    .catch((error) => {
      currentRequest = null;
      throw error;
    });
  return currentRequest;
}

export function rememberCurrentUser(user: CurrentUser | null): void {
  currentRequest = Promise.resolve({ user });
}
