import { Dashboard } from '@/components/vault/dashboard'
import { DurableDashboard } from '@/components/vault/durable-dashboard'

export default function Page() {
  return process.env.VAULT_MODE === 'simulator' ? <Dashboard /> : <DurableDashboard />
}
