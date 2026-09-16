import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { getAuthHeaders } from '../../utils/http.js'
import { logError } from '../../utils/log.js'
import { getLimkenionUserAgent } from '../../utils/userAgent.js'

/**
 * Fetch the user's first Limkenion token date and store in config.
 * This is called after successful login to cache when they started using Limkenion.
 */
export async function fetchAndStoreLimkenionFirstTokenDate(): Promise<void> {
  try {
    const config = getGlobalConfig()

    if (config.limkenionFirstTokenDate !== undefined) {
      return
    }

    const authHeaders = getAuthHeaders()
    if (authHeaders.error) {
      logError(new Error(`Failed to get auth headers: ${authHeaders.error}`))
      return
    }

    const oauthConfig = getOauthConfig()
    const url = `${oauthConfig.BASE_API_URL}/api/organization/limkenion_first_token_date`

    const response = await axios.get(url, {
      headers: {
        ...authHeaders.headers,
        'User-Agent': getLimkenionUserAgent(),
      },
      timeout: 10000,
    })

    const firstTokenDate = response.data?.first_token_date ?? null

    // Validate the date if it's not null
    if (firstTokenDate !== null) {
      const dateTime = new Date(firstTokenDate).getTime()
      if (isNaN(dateTime)) {
        logError(
          new Error(
            `Received invalid first_token_date from API: ${firstTokenDate}`,
          ),
        )
        // Don't save invalid dates
        return
      }
    }

    saveGlobalConfig(current => ({
      ...current,
      limkenionFirstTokenDate: firstTokenDate,
    }))
  } catch (error) {
    logError(error)
  }
}
