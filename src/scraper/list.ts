import * as cheerio from 'cheerio';
import { LetterboxdMovie, LETTERBOXD_BASE_URL } from ".";
import { fetchWithRetry } from './http';
import { resolveMoviesTolerant, isFilmLink, ScrapeOptions } from './resolve';
import logger from '../util/logger';
import Scraper from './scraper.interface';

export class ListScraper implements Scraper {
    constructor(
        private url: string,
        private take?: number,
        private strategy?: 'oldest' | 'newest',
        private opts: ScrapeOptions = {}
    ) {}

    async getMovies(): Promise<LetterboxdMovie[]> {
        let processUrl = this.url;

        if (this.strategy === 'oldest') {
            processUrl = this.url.replace(/\/$/, '') + '/by/date-earliest/';
        }

        const allMovieLinks = await this.getAllMovieLinks(processUrl);
        const linksToProcess = typeof this.take === 'number' ? allMovieLinks.slice(0, this.take) : allMovieLinks;

        return resolveMoviesTolerant(linksToProcess, this.opts, this.opts.filmCache);
    }

    private async getAllMovieLinks(baseUrl: string): Promise<string[]> {
        let currentUrl: string | null = baseUrl;
        const allLinks: string[] = [];
        
        while (currentUrl) {
            logger.debug(`Fetching page: ${currentUrl}`);
            
            const response = await fetchWithRetry(currentUrl, this.opts);
            if (!response.ok) {
                throw new Error(`Failed to fetch list page: ${response.status}`);
            }
            
            const html = await response.text();
            const pageLinks = this.getMovieLinksFromHtml(html);
            allLinks.push(...pageLinks);
            
            currentUrl = this.getNextPageUrl(html);
            
            if (currentUrl) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        
        logger.debug(`Retrieved ${allLinks.length} links from letterboxd list.`);

        return allLinks;
    }

    private getMovieLinksFromHtml(html: string): string[] {
        const $ = cheerio.load(html);
        const links: string[] = [];
        
        $('.react-component[data-target-link]').each((_, element) => {
            const filmLink = $(element).attr('data-target-link');
            if (isFilmLink(filmLink)) {
                links.push(filmLink);
            }
        });
        logger.debug(`Found ${links.length} links.`);
        return links;
    }

    private getNextPageUrl(html: string): string | null {
        const $ = cheerio.load(html);
        const nextLink = $('.paginate-nextprev .next').attr('href');
        
        if (nextLink) {
            return new URL(nextLink, LETTERBOXD_BASE_URL).toString();
        }
        
        return null;
    }
}