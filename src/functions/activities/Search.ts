import { Page } from 'puppeteer'
import axios from 'axios'

import { Workers } from '../Workers'

import { Counters, DashboardData } from '../../interface/DashboardData'
import { GoogleTrends } from '../../interface/GoogleDailyTrends'
import { GoogleSearch } from '../../interface/Search'


export class Search extends Workers {

    private searchPageURL = 'https://bing.com'

    public async doSearch(page: Page, data: DashboardData) {
        this.bot.log('SEARCH-BING', 'Starting bing searches')

        page = await this.bot.browser.utils.getLatestTab(page)

        let searchCounters: Counters = await this.bot.browser.func.getSearchPoints()
        let missingPoints = this.calculatePoints(searchCounters)

        if (missingPoints === 0) {
            this.bot.log('SEARCH-BING', `Bing searches for ${this.bot.isMobile ? 'MOBILE' : 'DESKTOP'} have already been completed`)
            return
        }

        // Generate search queries
        let googleSearchQueries = await this.getGoogleTrends(data.userProfile.attributes.country, missingPoints)
        googleSearchQueries = this.bot.utils.shuffleArray(googleSearchQueries)

        // Deduplicate the search terms
        googleSearchQueries = [...new Set(googleSearchQueries)]

        // Go to bing
        await page.goto(this.searchPageURL)

        let maxLoop = 0 // If the loop hits 10 this when not gaining any points, we're assuming it's stuck. If it ddoesn't continue after 5 more searches with alternative queries, abort search

        const queries: string[] = []
        // Mobile search doesn't seem to like related queries?
        googleSearchQueries.forEach(x => { this.bot.isMobile ? queries.push(x.topic) : queries.push(x.topic, ...x.related) })

        // Loop over Google search queries
        for (let i = 0; i < queries.length; i++) {
            const query = queries[i] as string

            this.bot.log('SEARCH-BING', `${missingPoints} Points Remaining | Query: ${query} | Mobile: ${this.bot.isMobile}`)

            searchCounters = await this.bingSearch(page, query)
            const newMissingPoints = this.calculatePoints(searchCounters)

            // If the new point amount is the same as before
            if (newMissingPoints == missingPoints) {
                maxLoop++ // Add to max loop
            } else { // There has been a change in points
                maxLoop = 0 // Reset the loop
            }

            missingPoints = newMissingPoints

            if (missingPoints === 0) {
                break
            }

            // If we didn't gain points for 10 iterations, assume it's stuck
            if (maxLoop > 10) {
                this.bot.log('SEARCH-BING', 'Search didn\'t gain point for 10 iterations aborting searches', 'warn')
                maxLoop = 0 // Reset to 0 so we can retry with related searches below
                break
            }
        }

        // If we still got remaining search queries, generate extra ones
        if (missingPoints > 0) {
            this.bot.log('SEARCH-BING', `Search completed but we're missing ${missingPoints} points, generating extra searches`)

            let i = 0
            while (missingPoints > 0) {
                const query = googleSearchQueries[i++] as GoogleSearch

                // Get related search terms to the Google search queries
                const relatedTerms = await this.getRelatedTerms(query?.topic)
                if (relatedTerms.length > 3) {
                    // Search for the first 2 related terms
                    for (const term of relatedTerms.slice(1, 3)) {
                        this.bot.log('SEARCH-BING-EXTRA', `${missingPoints} Points Remaining | Query: ${term} | Mobile: ${this.bot.isMobile}`)

                        searchCounters = await this.bingSearch(page, query.topic)
                        const newMissingPoints = this.calculatePoints(searchCounters)

                        // If the new point amount is the same as before
                        if (newMissingPoints == missingPoints) {
                            maxLoop++ // Add to max loop
                        } else { // There has been a change in points
                            maxLoop = 0 // Reset the loop
                        }

                        missingPoints = newMissingPoints

                        // If we satisfied the searches
                        if (missingPoints === 0) {
                            break
                        }

                        // Try 5 more times, then we tried a total of 15 times, fair to say it's stuck
                        if (maxLoop > 5) {
                            this.bot.log('SEARCH-BING-EXTRA', 'Search didn\'t gain point for 5 iterations aborting searches', 'warn')
                            return
                        }
                    }
                }
            }
        }

        this.bot.log('SEARCH-BING', 'Completed searches')
    }

    private async bingSearch(searchPage: Page, query: string) {
        // Try a max of 5 times
        for (let i = 0; i < 5; i++) {
            try {
                const searchBar = '#sb_form_q'
                await searchPage.waitForSelector(searchBar, { visible: true, timeout: 10_000 })
                await searchPage.click(searchBar) // Focus on the textarea
                await this.bot.utils.wait(500)
                await searchPage.keyboard.down('Control')
                await searchPage.keyboard.press('A')
                await searchPage.keyboard.press('Backspace')
                await searchPage.keyboard.up('Control')
                await searchPage.keyboard.type(query)
                await searchPage.keyboard.press('Enter')

                if (this.bot.config.searchSettings.scrollRandomResults) {
                    await this.bot.utils.wait(2000)
                    await this.randomScroll(searchPage)
                }

                if (this.bot.config.searchSettings.clickRandomResults) {
                    await this.bot.utils.wait(2000)
                    await this.clickRandomLink(searchPage)
                }

                await this.bot.utils.wait(Math.floor(this.bot.utils.randomNumber(this.bot.config.searchSettings.searchDelay.min, this.bot.config.searchSettings.searchDelay.max)))

                return await this.bot.browser.func.getSearchPoints()

            } catch (error) {
                if (i === 5) {
                    this.bot.log('SEARCH-BING', 'Failed after 5 retries... An error occurred:' + error, 'error')
                    break

                }
                this.bot.log('SEARCH-BING', 'Search failed, An error occurred:' + error, 'error')
                this.bot.log('SEARCH-BING', `Retrying search, attempt ${i}/5`, 'warn')

                // Reset the tabs
                const browser = searchPage.browser()
                const tabs = await browser.pages()
                const lastTab = await this.bot.browser.utils.getLatestTab(searchPage)

                if (tabs.length === 4) {
                    await lastTab.close()

                } else if (tabs.length === 2) {
                    const newPage = await browser.newPage()
                    await newPage.goto(this.searchPageURL)

                } else {
                    await lastTab.goBack()
                }

                await this.bot.utils.wait(4000)
            }
        }

        this.bot.log('SEARCH-BING', 'Search failed after 5 retries, ending', 'error')
        return await this.bot.browser.func.getSearchPoints()
    }

    private async getGoogleTrends(geoLocale: string, queryCount: number): Promise<GoogleSearch[]> {
        const queryTerms: GoogleSearch[] = []
        let i = 0

        geoLocale = (this.bot.config.searchSettings.useGeoLocaleQueries && geoLocale.length === 2) ? geoLocale.toUpperCase() : 'US'

        this.bot.log('SEARCH-GOOGLE-TRENDS', `Generating search queries, can take a while! | GeoLocale: ${geoLocale}`)

        while (queryCount > queryTerms.length) {
            i += 1
            const date = new Date()
            date.setDate(date.getDate() - i)
            const formattedDate = this.formatDate(date)

            try {
                const request = {
                    url: `https://trends.google.com/trends/api/dailytrends?geo=${geoLocale}&hl=en&ed=${formattedDate}&ns=15`,
                    method: 'GET',
                    headers: {
                        'Content-Type': 'application/json'
                    }
                }

                const response = await axios(request)

                const data: GoogleTrends = JSON.parse((await response.data).slice(5))

                for (const topic of data.default.trendingSearchesDays[0]?.trendingSearches ?? []) {
                    queryTerms.push({
                        topic: topic.title.query.toLowerCase(),
                        related: topic.relatedQueries.map(x => x.query.toLowerCase())
                    })
                }

            } catch (error) {
                this.bot.log('SEARCH-GOOGLE-TRENDS', 'An error occurred:' + error, 'error')
            }
        }

        return queryTerms
    }

    private async getRelatedTerms(term: string): Promise<string[]> {
        try {
            const request = {
                url: `https://api.bing.com/osjson.aspx?query=${term}`,
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            }

            const response = await axios(request)

            return response.data[1] as string[]
        } catch (error) {
            this.bot.log('SEARCH-BING-RELTATED', 'An error occurred:' + error, 'error')
        }
        return []
    }

    private formatDate(date: Date): string {
        const year = date.getFullYear()
        const month = String(date.getMonth() + 1).padStart(2, '0')
        const day = String(date.getDate()).padStart(2, '0')

        return `${year}${month}${day}`
    }

    private async randomScroll(page: Page) {
        try {
            // Press the arrow down key to scroll
            for (let i = 0; i < this.bot.utils.randomNumber(5, 400); i++) {
                await page.keyboard.press('ArrowDown')
            }

        } catch (error) {
            this.bot.log('SEARCH-RANDOM-SCROLL', 'An error occurred:' + error, 'error')
        }
    }

    private async clickRandomLink(page: Page) {
        try {
            const searchListingURL = new URL(page.url()) // Get searchPage info before clicking

            await page.click('#b_results .b_algo h2').catch(() => { }) // Since we don't really care if it did it or not

            // Will get current tab if no new one is created
            let lastTab = await this.bot.browser.utils.getLatestTab(page)

            // Let website load, if it doesn't load within 5 sec. exit regardless
            await this.bot.utils.wait(5000)

            let lastTabURL = new URL(lastTab.url()) // Get new tab info

            // Check if the URL is different from the original one, don't loop more than 5 times.
            let i = 0
            while (lastTabURL.href !== searchListingURL.href && i < 5) {
                const browser = page.browser()
                const tabs = await browser.pages()

                if (tabs.length === 4) {
                    await lastTab.close()

                } else if (tabs.length === 2) {
                    const newPage = await browser.newPage()
                    await newPage.goto(searchListingURL.href)

                } else {
                    await lastTab.goBack()
                }

                // End of loop, refresh lastPage
                lastTab = await this.bot.browser.utils.getLatestTab(page) // Finally update the lastTab var again
                lastTabURL = new URL(lastTab.url()) // Get new tab info
                i++
            }

        } catch (error) {
            this.bot.log('SEARCH-RANDOM-CLICK', 'An error occurred:' + error, 'error')
        }
    }

    private calculatePoints(counters: Counters) {
        const mobileData = counters.mobileSearch?.[0] // Mobile searches
        const genericData = counters.pcSearch?.[0] // Normal searches
        const edgeData = counters.pcSearch?.[1] // Edge searches

        const missingPoints = (this.bot.isMobile && mobileData)
            ? mobileData.pointProgressMax - mobileData.pointProgress
            : (edgeData ? edgeData.pointProgressMax - edgeData.pointProgress : 0)
            + (genericData ? genericData.pointProgressMax - genericData.pointProgress : 0)

        return missingPoints
    }
}