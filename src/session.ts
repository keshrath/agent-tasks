let currentSession: { id: string; name: string } | null = null;

export function getCurrentSession() {
  return currentSession;
}

export function setSession(id: string, name: string): void {
  currentSession = { id, name };
}

export function clearSession(): void {
  currentSession = null;
}
