import type { Command } from '../../commands.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { isPolicyAllowed } from '../../services/policyLimits/index.js'

const web = {
  type: 'local-jsx',
  name: 'web-setup',
  description:
    'Setup Limkenion on the web (requires connecting your GitHub account)',
  availability: ['limkenion-ai'],
  isEnabled: () =>
    getFeatureValue_CACHED_MAY_BE_STALE('内部代号_cobalt_lantern', false) &&
    isPolicyAllowed('allow_remote_sessions'),
  get isHidden() {
    return !isPolicyAllowed('allow_remote_sessions')
  },
  load: () => import('./remote-setup.js'),
} satisfies Command

export default web
