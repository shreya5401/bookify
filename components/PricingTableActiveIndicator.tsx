'use client'

import { useEffect } from 'react'

// i18n strings — replace with your i18n solution if needed
const LABEL = 'Your Current Plan'

/**
 * Mounts alongside a Clerk <PricingTable />.
 * After Clerk renders the pricing cards it:
 *   1. Finds the active-plan card via a stable DOM signal (disabled CTA button,
 *      aria-current, or data-active attribute).
 *   2. Adds the .is-active modifier class to that card.
 *   3. Inserts a real <div class="current-plan-indicator"> element so the label
 *      is in the DOM (screen-reader and i18n friendly) instead of a CSS ::after.
 */
export default function PricingTableActiveIndicator() {
  useEffect(() => {
    const MAX_ATTEMPTS = 20
    const RETRY_MS = 300
    let attempts = 0

    function applyActiveIndicator() {
      const cards = Array.from(
        document.querySelectorAll<HTMLElement>('.cl-pricingTableCard')
      )

      if (!cards.length) {
        if (++attempts < MAX_ATTEMPTS) {
          setTimeout(applyActiveIndicator, RETRY_MS)
        }
        return
      }

      // Clean up any indicator applied by a previous run
      cards.forEach((card) => {
        card.classList.remove('is-active')
        card.querySelector('.current-plan-indicator')?.remove()
      })

      let activeCard: HTMLElement | null = null

      // Signal 1: Clerk disables the CTA button on the plan the user already has
      for (const card of cards) {
        const disabledBtn = card.querySelector<HTMLElement>(
          'button[disabled], button[aria-disabled="true"]'
        )
        if (disabledBtn) {
          activeCard = card
          break
        }
      }

      // Signal 2: explicit ARIA / data attributes Clerk may expose
      if (!activeCard) {
        activeCard = document.querySelector<HTMLElement>(
          '.cl-pricingTableCard[aria-current],' +
          '.cl-pricingTableCard[data-active="true"],' +
          '.cl-pricingTableCard[data-selected="true"]'
        )
      }

      if (!activeCard) return

      activeCard.classList.add('is-active')

      const indicator = document.createElement('div')
      indicator.className = 'current-plan-indicator'
      indicator.setAttribute('role', 'status')
      indicator.setAttribute('aria-live', 'polite')
      indicator.textContent = LABEL

      const content =
        activeCard.querySelector<HTMLElement>('.cl-pricingTableCardContent') ??
        activeCard
      content.appendChild(indicator)
    }

    applyActiveIndicator()
  }, [])

  return null
}
