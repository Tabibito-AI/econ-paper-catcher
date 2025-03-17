import dotenv from 'dotenv';
import fetch from 'node-fetch';
import fs from 'fs';
import axios from 'axios';
import { JSDOM } from 'jsdom';
import { parseStringPromise } from 'xml2js';
import WebScraper from './src/webScraper.js';

dotenv.config();

import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';

class RateLimiter {
    constructor(requestsPerMinute, maxRetries = 1) {
        this.requestsPerMinute = requestsPerMinute;
        this.maxRetries = maxRetries;
        this.queue = [];
        this.processing = false;
        this.lastRequestTime = {};
        this.retryCount = {};
    }

    async addToQueue(fn, apiKey) {
        return new Promise((resolve, reject) => {
            this.queue.push({ fn, resolve, reject, apiKey });
            this.processQueue();
        });
    }

    calculateBackoff(retryCount) {
        const jitter = Math.random() * 1000;
        return Math.min(Math.pow(2, retryCount) * 2000 + jitter, 50000);
    }

    async processQueue() {
        if (this.processing || this.queue.length === 0) return;
        this.processing = true;

        const { fn, resolve, reject, apiKey } = this.queue.shift();
        const now = Date.now();
        const lastRequest = this.lastRequestTime[apiKey] || 0;
        const timeSinceLastRequest = now - lastRequest;
        const minDelay = (60 * 1000) / this.requestsPerMinute;

        if (timeSinceLastRequest < minDelay) {
            await new Promise(resolve => setTimeout(resolve, minDelay - timeSinceLastRequest));
        }

        try {
            const result = await this.executeWithRetry(fn, apiKey);
            this.lastRequestTime[apiKey] = Date.now();
            this.retryCount[apiKey] = 0;
            resolve(result);
        } catch (error) {
            reject(error);
        } finally {
            this.processing = false;
            setTimeout(() => this.processQueue(), 100);
        }
    }

    async executeWithRetry(fn, apiKey, retryCount = 0) {
        try {
            const result = await fn();
            return result;
        } catch (error) {
            if ((error.status === 429 || error.status === 503 || error.status === 401) && retryCount < this.maxRetries) {
                const backoffTime = this.calculateBackoff(retryCount);
                console.log(`API error for ${apiKey}. Status: ${error.status}. Retrying in ${backoffTime / 1000} seconds...`);
                await new Promise(resolve => setTimeout(resolve, backoffTime));
                return this.executeWithRetry(fn, apiKey, retryCount + 1);
            }
            throw error;
        }
    }
}

const geminiLimiter = new RateLimiter(8);
const apiLimiter = new RateLimiter(20);
const webScraper = new WebScraper();

class ArxivClient {
    constructor(config = {}) {
        // arXiv APIの検索構文に合わせてクエリを変換
        const searchTerms = config.searchQuery || process.env.SEARCH_QUERY || '"large language model" OR "machine learning"';
        this.searchQuery = `abs:${searchTerms} OR ti:${searchTerms}`;
        this.maxRetries = config.maxRetries || 1;
        this.baseDelay = config.baseDelay || 2000;
        this.timeout = config.timeout || 30000;
        
        console.log('arXiv initialized with query:', this.searchQuery);
    }

    async fetchArxivPapers(maxResults = 20) {
        const apiUrl = `http://export.arxiv.org/api/query?search_query=${encodeURIComponent(this.searchQuery)}&start=0&max_results=${maxResults}`;

        try {
            const response = await fetch(apiUrl);
            if (!response.ok) {
                throw new Error(`arXiv API request failed with status ${response.status}`);
            }
            const xmlData = await response.text();

            const result = await parseStringPromise(xmlData);

            const entries = result.feed.entry || [];
            const papers = await Promise.all(entries.map(async entry => {
                const paper = {
                    id: entry.id[0],
                    title: entry.title[0].trim(),
                    summary: entry.summary[0].trim(),
                    published: entry.published[0],
                    updated: entry.updated[0],
                    authors: entry.author ? entry.author.map(author => author.name[0]) : [],
                    categories: entry.category ? entry.category.map(cat => cat.$.term) : [],
                    link: entry.link ? entry.link.find(link => link.$.rel === 'alternate')?.$.href : null,
                };

                if (!paper.summary && paper.link) {
                    paper.summary = await webScraper.scrapeAbstractFromUrl(paper.link) || 'No abstract available';
                }

                return paper;
            }));

            console.log('Fetched papers from arXiv:', papers);

            return papers.map(paper => ({
                title: paper.title,
                author: paper.authors.join(', '),
                publicationDate: paper.published,
                abstract: paper.summary,
                journal: 'arXiv',
                doi: paper.id,
                link: paper.link,
            }));
        } catch (error) {
            console.error('Error fetching arXiv papers:', error);
            throw error;
        }
    }
}

class SpringerClient {
    constructor() {
        this.apiKey = process.env.SPRINGER_API_KEY;
        this.searchQuery = process.env.SPRINGER_SEARCH_QUERY || '(keyword:"large language model" OR keyword:"machine learning" OR keyword:"artificial intelligence" OR keyword:"deep learning")';

        if (!this.apiKey) {
            console.warn('Warning: SPRINGER_API_KEY not set in environment variables');
            throw new Error('Springer API key is not set');
        }
    }

    async fetchSpringerPapers(maxResults = 20) {
        const apiUrl = `https://api.springernature.com/metadata/json?api_key=${this.apiKey}&q=${encodeURIComponent(this.searchQuery)}&p=${maxResults}&s=1`;

        console.log('Request URL:', apiUrl);

        try {
            const response = await fetch(apiUrl);
            if (!response.ok) {
                throw new Error(`Springer API request failed with status ${response.status}`);
            }
            const jsonData = await response.json();

            const records = jsonData.records || [];
            const papers = await Promise.all(records.map(async record => {
                const paper = {
                    id: record.doi,
                    title: record.title,
                    summary: record.abstract || 'No abstract available',
                    published: record.publicationDate,
                    authors: record.creators ? record.creators.map(creator => creator.creator) : [],
                    categories: record.subjects ? record.subjects.map(subject => subject.subject) : [],
                    link: record.url || `https://doi.org/${record.doi}`,
                    journal: record.publicationName || 'Springer',
                };

                if (!paper.summary && paper.link) {
                    paper.summary = await webScraper.scrapeAbstractFromUrl(paper.link) || 'No abstract available';
                }

                return paper;
            }));

            console.log('Fetched papers from Springer:', papers);

            return papers.map(paper => ({
                title: paper.title,
                author: paper.authors.join(', '),
                publicationDate: paper.published,
                abstract: paper.summary,
                journal: paper.journal,
                doi: paper.id,
                link: paper.link,
            }));
        } catch (error) {
            console.error('Error fetching Springer papers:', error);
            throw error;
        }
    }
}

class SemanticScholarClient {
    constructor(config = {}) {
        this.searchQuery = config.searchQuery || process.env.SEARCH_QUERY || '"large language model" OR "machine learning"';
        this.requestsPerMinute = 50;
        this.lastRequestTime = 0;
        this.maxRetries = config.maxRetries || 1;
        this.baseDelay = config.baseDelay || 2000;
        this.timeout = config.timeout || 30000;
        
        console.log('SemanticScholar initialized with query:', this.searchQuery);
    }

    async sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async enforceRateLimit() {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        const minDelay = (60 * 1000) / this.requestsPerMinute;

        if (timeSinceLastRequest < minDelay) {
            await this.sleep(minDelay - timeSinceLastRequest);
        }
        this.lastRequestTime = Date.now();
    }

    async fetchWithRetry(url, options = {}, retryCount = 0) {
        const maxRetries = 2;
        const baseDelay = 2000;

        try {
            await this.enforceRateLimit();

            const response = await fetch(url, options);
            if (!response.ok) {
                if (response.status === 429 && retryCount < maxRetries) {
                    const retryAfter = response.headers.get('Retry-After');
                    const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 :
                        baseDelay * Math.pow(2, retryCount);
                    console.warn(`Rate limited. Retrying after ${delay}ms...`);
                    await this.sleep(delay);
                    return this.fetchWithRetry(url, options, retryCount + 1);
                }
                throw new Error(`Semantic Scholar API request failed with status ${response.status}`);
            }
            return response;
        } catch (error) {
            if (retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                console.warn(`Request failed. Retrying after ${delay}ms...`);
                await this.sleep(delay);
                return this.fetchWithRetry(url, options, retryCount + 1);
            }
            throw error;
        }
    }

    async fetchSemanticScholarPapers(maxResults = 20) {
        const apiUrl = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(this.searchQuery)}&limit=${maxResults}&sort=published`;

        try {
            const response = await this.fetchWithRetry(apiUrl);
            const jsonData = await response.json();

            const papers = jsonData.data || [];
            const detailedPapers = await Promise.all(papers.map(async paper => {
                const paperDetails = await this.fetchPaperDetails(paper.paperId);
                const paperInfo = {
                    id: paper.paperId,
                    title: paper.title,
                    abstract: paperDetails.abstract || 'No abstract available',
                    published: paperDetails.year ? new Date(paperDetails.year, 0, 1).toISOString() : 'No publication date available',
                    authors: paperDetails.authors ? paperDetails.authors.map(author => author.name) : [],
                    journal: paperDetails.venue || 'No journal available',
                    doi: paperDetails.doi || null,
                    link: paperDetails.url || `https://www.semanticscholar.org/paper/${paper.paperId}`,
                };

                if (!paperInfo.abstract && paperInfo.link) {
                    paperInfo.abstract = await webScraper.scrapeAbstractFromUrl(paperInfo.link) || 'No abstract available';
                }

                return paperInfo;
            }));

            console.log('Fetched papers from Semantic Scholar:', detailedPapers);

            return detailedPapers.map(paper => ({
                title: paper.title,
                author: paper.authors.join(', '),
                publicationDate: paper.published,
                abstract: paper.abstract,
                journal: paper.journal,
                doi: paper.doi,
                link: paper.link,
            }));
        } catch (error) {
            console.error('Error fetching Semantic Scholar papers:', error);
            throw error;
        }
    }

    async fetchPaperDetails(paperId) {
        const apiUrl = `https://api.semanticscholar.org/v1/paper/${paperId}`;

        try {
            const response = await this.fetchWithRetry(apiUrl);
            return await response.json();
        } catch (error) {
            console.error('Error fetching paper details from Semantic Scholar:', error);
            throw error;
        }
    }
}

class PubMedClient {
    constructor() {
        this.apiKey = process.env.PUBMED_API_KEY;
        this.searchQuery = process.env.PUBMED_SEARCH_QUERY ||
            '("large language model"[Title/Abstract] OR "machine learning"[Title/Abstract] OR ' +
            '"artificial intelligence"[Title/Abstract] OR "deep learning"[Title/Abstract]) AND ' +
            '("2023"[Date - Publication] : "3000"[Date - Publication])';
    }

    async fetchWithRetry(url, options = {}, retryCount = 0) {
        const maxRetries = 3;
        const baseDelay = 400;

        try {
            const response = await fetch(url, options);
            if (!response.ok) {
                if (response.status === 429 && retryCount < maxRetries) {
                    const retryAfter = response.headers.get('Retry-After') || baseDelay * Math.pow(2, retryCount);
                    console.warn(`Rate limited. Retrying after ${retryAfter}ms...`);
                    await new Promise(resolve => setTimeout(resolve, retryAfter));
                    return this.fetchWithRetry(url, options, retryCount + 1);
                }
                throw new Error(`PubMed API request failed with status ${response.status}`);
            }
            return response;
        } catch (error) {
            if (retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                console.warn(`Request failed. Retrying after ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.fetchWithRetry(url, options, retryCount + 1);
            }
            throw error;
        }
    }

    async fetchPubMedPapers(maxResults = 20) {
        const apiUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(this.searchQuery)}&retmax=${maxResults}&sort=pubdate&api_key=${this.apiKey}`;

        try {
            const response = await this.fetchWithRetry(apiUrl);
            const xmlData = await response.text();

            const result = await parseStringPromise(xmlData);

            const paperIds = result.eSearchResult?.IdList?.[0]?.Id || [];

            const papers = [];
            for (const id of paperIds) {
                try {
                    const paperDetails = await this.fetchPaperDetails(id);
                    const paper = {
                        id: id,
                        title: paperDetails.title || 'No title available',
                        abstract: paperDetails.abstract || 'No abstract available',
                        published: paperDetails.published || 'No publication date available',
                        authors: paperDetails.authors || [],
                        journal: paperDetails.journal || 'No journal available',
                        doi: paperDetails.doi || null,
                        link: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
                    };

                    if (!paper.abstract && paper.link) {
                        console.log(`Attempting to scrape abstract from ${paper.link}`);
                        paper.abstract = await webScraper.scrapeAbstractFromUrl(paper.link) || 'No abstract available';
                        console.log(`Scraping result for ${paper.link}:`, paper.abstract !== 'No abstract available' ? 'Success' : 'Failed');
                    }

                    papers.push(paper);
                    await new Promise(resolve => setTimeout(resolve, 400));
                } catch (error) {
                    console.error(`Error fetching details for paper ID ${id}:`, error);
                }
            }

            console.log('Fetched papers from PubMed:', papers);

            return papers.map(paper => ({
                title: paper.title,
                author: paper.authors.join(', '),
                publicationDate: paper.published,
                abstract: paper.abstract,
                journal: paper.journal,
                doi: paper.doi,
                link: paper.link,
            }));
        } catch (error) {
            console.error('Error fetching PubMed papers:', error);
            throw error;
        }
    }

    async fetchPaperDetails(paperId) {
        const apiUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${paperId}&retmode=xml&api_key=${this.apiKey}`;

        try {
            const response = await this.fetchWithRetry(apiUrl);
            const xmlData = await response.text();

            const result = await parseStringPromise(xmlData);

            const paperDetails = result.PubmedArticleSet?.PubmedArticle?.[0]?.MedlineCitation?.[0]?.Article?.[0];
            const authors = paperDetails?.AuthorList?.[0]?.Author?.map(author => `${author?.ForeName?.[0]} ${author?.LastName?.[0]}`) || [];
            const journal = paperDetails?.Journal?.[0]?.Title?.[0] || 'No journal available';
            const abstractText = paperDetails?.Abstract?.[0]?.AbstractText;
            const abstract = Array.isArray(abstractText) ?
                abstractText.map(text => (typeof text === 'string' ? text.trim() : String(text || ''))).join(' ') :
                (typeof abstractText === 'string' ? abstractText.trim() : 'No abstract available');
            const published = paperDetails?.Journal?.[0]?.JournalIssue?.[0]?.PubDate?.[0]?.Year?.[0] || 'No publication date available';
            const doi = paperDetails?.ELocationID?.find(id => id.$.EIdType === 'doi')?._ || null;

            return {
                title: paperDetails?.ArticleTitle?.[0] || 'No title available',
                abstract: abstract,
                published: published,
                authors: authors,
                journal: journal,
                doi: doi,
            };
        } catch (error) {
            console.error('Error fetching paper details from PubMed:', error);
            throw error;
        }
    }
}

class APIClient {
    constructor() {
        this.elsevierApiKey = process.env.ELSEVIER_API_KEY;
        this.elsevierInstToken = process.env.ELSEVIER_INST_TOKEN;
        this.geminiApiKey = process.env.GEMINI_API_KEY;
        this.springerApiKey = process.env.SPRINGER_API_KEY;
        
        const defaultQuery = '"large language model" OR "machine learning" OR "artificial intelligence" OR "deep learning"';
        this.searchQuery = process.env.SEARCH_QUERY || defaultQuery;
        
        const clientConfig = {
            maxRetries: 1,
            baseDelay: 2000,
            timeout: 30000,
            searchQuery: this.searchQuery
        };
        
        this.geminiPrompt = process.env.GEMINI_PROMPT;
        
        const corssFreeAPIs = {
            ...clientConfig,
            useProxy: true,
            headers: {
                'Accept': 'application/json'
            }
        };

        this.crossRefClient = new CrossRefClient({
            ...corssFreeAPIs,
            filter: 'has-abstract:true'
        });

        this.arxivClient = new ArxivClient({
            ...clientConfig,
            sortBy: 'submittedDate',
            sortOrder: 'descending'
        });

        this.springerClient = new SpringerClient({
            ...clientConfig,
            apiKey: this.springerApiKey,
            includeKeywords: true
        });

        this.semanticScholarClient = new SemanticScholarClient({
            ...clientConfig,
            fields: ['title', 'abstract', 'year', 'authors', 'venue', 'doi', 'url']
        });

        this.pubMedClient = new PubMedClient({
            ...clientConfig,
            dateRange: {
                start: '2023',
                end: '3000'
            }
        });

        this.scopusClient = new ScopusClient({
            ...clientConfig,
            apiKey: this.elsevierApiKey
        });

        this.genAI = new GoogleGenerativeAI(this.geminiApiKey);

        if (!this.elsevierApiKey) {
            console.warn('Warning: ELSEVIER_API_KEY not set in environment variables');
        }
        if (!this.elsevierInstToken) {
            console.warn('Warning: ELSEVIER_INST_TOKEN not set in environment variables');
        }
        if (!this.geminiApiKey) {
            console.warn('Warning: GEMINI_API_KEY not set in environment variables');
            throw new Error('Gemini API key is not set');
        }
        if (!this.springerApiKey) {
            console.warn('Warning: SPRINGER_API_KEY not set in environment variables');
        }
    }

    async fetchCrossRefPapers() {
        try {
            return await this.crossRefClient.fetchCrossRefPapers(this.searchQuery);
        } catch (error) {
            console.error('Error in APIClient.fetchCrossRefPapers:', error);
            throw error;
        }
    }

    async fetchArxivPapers(maxResults = 20) {
        try {
            return await this.arxivClient.fetchArxivPapers(maxResults);
        } catch (error) {
            console.error('Error in APIClient.fetchArxivPapers:', error);
            throw error;
        }
    }

    async fetchSpringerPapers(maxResults = 20) {
        try {
            return await this.springerClient.fetchSpringerPapers(maxResults);
        } catch (error) {
            console.error('Error in APIClient.fetchSpringerPapers:', error);
            throw error;
        }
    }

    async fetchSemanticScholarPapers(maxResults = 20) {
        try {
            return await this.semanticScholarClient.fetchSemanticScholarPapers(maxResults);
        } catch (error) {
            console.error('Error in APIClient.fetchSemanticScholarPapers:', error);
            throw error;
        }
    }

    async fetchPubMedPapers(maxResults = 20) {
        try {
            return await this.pubMedClient.fetchPubMedPapers(maxResults);
        } catch (error) {
            console.error('Error in APIClient.fetchPubMedPapers:', error);
            throw error;
        }
    }

    async fetchElsevierPapers() {
        if (!this.elsevierApiKey) {
            console.warn('Skipping Elsevier API calls - no API key provided');
            return [];
        }

        try {
            // Fetch papers from both Scopus and ScienceDirect in parallel
            const [scopusPapers, scienceDirectPapers] = await Promise.all([
                this.fetchScopusPapers(),
                this.fetchScienceDirectPapers()
            ]);

            // Combine and remove duplicates based on DOI
            const allPapers = [...scopusPapers, ...scienceDirectPapers];
            const uniquePapers = allPapers.reduce((acc, current) => {
                const x = acc.find(item => item.doi === current.doi);
                if (!x) {
                    return acc.concat([current]);
                } else {
                    // If we have both versions, prefer the one with more complete data
                    const existing = acc.findIndex(item => item.doi === current.doi);
                    if (current.abstract !== 'No abstract available' && acc[existing].abstract === 'No abstract available') {
                        acc[existing] = current;
                    }
                    return acc;
                }
            }, []);

            return uniquePapers;
        } catch (error) {
            console.error('Error in fetchElsevierPapers:', error);
            return [];
        }
    }

    async fetchScopusPapers() {
        if (!this.elsevierApiKey) {
            console.warn('Skipping Scopus API call - API key is required');
            return [];
        }

        try {
            const url = new URL('https://api.elsevier.com/content/search/scopus');
            
            // Format the query for Scopus syntax without URL encoding
            const terms = this.searchQuery.split(/\s+OR\s+/).map(term => 
                term.trim().replace(/^["']|["']$/g, '') // Remove quotes
            );
            const scopusQuery = terms.map(term => 
                `TITLE-ABS-KEY(${term})`
            ).join(' OR ');
            
            // Add open access filter without URL encoding
            const fullQuery = `(${scopusQuery}) AND OPENACCESS(1)`;
            
            // Set URL parameters without additional encoding
            const params = {
                query: fullQuery,
                apiKey: this.elsevierApiKey,
                count: '25',
                sort: '-coverDate',
                view: 'STANDARD',
                httpAccept: 'application/json'
            };

            // Add parameters to URL using URLSearchParams
            Object.entries(params).forEach(([key, value]) => {
                url.searchParams.set(key, value);
            });

            // フィールドパラメータを手動で追加（エンコードを防ぐため）
            const fields = [
                'dc:identifier',
                'dc:title',
                'dc:creator',
                'prism:coverDate',
                'prism:doi',
                'prism:publicationName'
            ];
            url.search = url.searchParams.toString() + `&field=${fields.join(',')}`;
            
            console.log('Scopus search query:', fullQuery);
            console.log('Scopus API Request URL:', url.toString());

            const headers = {
                'X-ELS-APIKey': this.elsevierApiKey,
                'Accept': 'application/json'
            };

            const response = await fetch(url.toString(), {
                method: 'GET',
                headers: headers
            });

            if (!response.ok) {
                const errorData = await response.json();
                console.error('Scopus API Error:', errorData);
                if (response.status === 401) {
                    console.warn('Authentication failed for Scopus API. Check your API key.');
                    return [];
                }
                throw new Error(`Scopus API request failed: ${response.status} - ${errorData['service-error']?.status?.statusText || 'Unknown error'}`);
            }

            const data = await response.json();
            const entries = data['search-results']?.entry || [];

            if (entries.length === 0) {
                console.warn('No open access results found in Scopus');
                return [];
            }

            console.log(`Found ${entries.length} open access papers in Scopus`);

            const papers = await Promise.all(entries.map(async entry => {
                return {
                    title: entry['dc:title'] || 'No title available',
                    authors: entry['dc:creator'] || 'No authors available',
                    abstract: 'Abstract not available in Standard view',
                    publicationDate: entry['prism:coverDate'] || 'No date available',
                    doi: entry['prism:doi'] || null,
                    url: `https://doi.org/${entry['prism:doi']}` || null,
                    journal: entry['prism:publicationName'] || 'No journal available',
                    source: 'Scopus (Open Access)'
                };
            }));

            return papers.filter(paper => paper !== null);
        } catch (error) {
            console.error('Error fetching papers from Scopus:', error);
            return [];
        }
    }

    async fetchScienceDirectPapers() {
        if (!this.elsevierApiKey || !this.elsevierInstToken) {
            console.warn('Skipping ScienceDirect API call - missing credentials:', {
                apiKey: !this.elsevierApiKey,
                instToken: !this.elsevierInstToken
            });
            return [];
        }

        try {
            const url = new URL('https://api.elsevier.com/content/search/sciencedirect');
            
            // Set URL parameters without additional encoding
            const params = {
                query: this.searchQuery,
                apiKey: this.elsevierApiKey,
                count: '25',
                startDate: '2000',
                endDate: '2024',
                view: 'COMPLETE',
                httpAccept: 'application/json',
                insttoken: this.elsevierInstToken
            };

            // Add parameters to URL using URLSearchParams
            Object.entries(params).forEach(([key, value]) => {
                url.searchParams.set(key, value);
            });

            // フィールドパラメータを手動で追加（エンコードを防ぐため）
            const fields = [
                'dc:title',
                'dc:creator',
                'dc:description',
                'prism:coverDate',
                'prism:doi',
                'prism:url',
                'prism:publicationName'
            ];
            url.search = url.searchParams.toString() + `&field=${fields.join(',')}`;
            
            console.log('ScienceDirect API Request URL:', url.toString());

            const headers = {
                'X-ELS-APIKey': this.elsevierApiKey,
                'X-ELS-Insttoken': this.elsevierInstToken,
                'Accept': 'application/json'
            };

            const response = await fetch(url.toString(), {
                method: 'GET',
                headers: headers
            });

            if (!response.ok) {
                const errorData = await response.json();
                console.error('ScienceDirect API Error:', errorData);
                if (response.status === 401) {
                    console.warn('Authentication failed for ScienceDirect API. Check your credentials.');
                    return [];
                }
                throw new Error(`ScienceDirect API request failed: ${response.status} - ${errorData['service-error']?.status?.statusText || 'Unknown error'}`);
            }

            const data = await response.json();
            if (!data['search-results']?.entry) {
                console.warn('No results found in ScienceDirect response');
                return [];
            }

            console.log(`Found ${data['search-results'].entry.length} papers in ScienceDirect`);

            const papers = await Promise.all(data['search-results'].entry.map(async entry => {
                let abstract = entry['dc:description'];
                
                // If no abstract in search results, try to fetch it using DOI
                if (!abstract && entry['prism:doi']) {
                    abstract = await this.fetchAbstractFromDOI(entry['prism:doi']);
                }

                return {
                    title: entry['dc:title'] || 'No title available',
                    authors: entry['dc:creator'] || 'No authors available',
                    abstract: abstract || 'No abstract available',
                    publicationDate: entry['prism:coverDate'] || 'No date available',
                    doi: entry['prism:doi'] || null,
                    url: entry['prism:url'] || null,
                    journal: entry['prism:publicationName'] || 'No journal available',
                    source: 'ScienceDirect'
                };
            }));

            return papers.filter(paper => paper !== null);
        } catch (error) {
            console.error('Error fetching papers from ScienceDirect:', error);
            return [];
        }
    }

    async fetchWithRateLimit(url, options = {}, apiKey = 'default', retryCount = 0) {
        const maxRetries = 3;
        const baseDelay = 2000;

        try {
            if (apiKey === 'elsevier' && !url.includes('apiKey')) {
                url += `&apiKey=${this.elsevierApiKey}`;
            }
            const response = await fetch(url, options);
            const responseBody = await response.json();
            console.log(`API Response for ${url}:`, responseBody);

            if (!response.ok) {
                if (response.status === 429 && retryCount < maxRetries) {
                    const resetTime = response.headers.get('X-RateLimit-Reset');
                    const delay = resetTime ? parseInt(resetTime, 10) * 1000 :
                        Math.min(this.baseDelay * Math.pow(2, retryCount), 30000);

                    console.warn(`Rate limited. Retrying after ${delay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    return this.fetchWithRateLimit(url, options, apiKey, retryCount + 1);
                }
                throw {
                    status: response.status,
                    message: responseBody,
                    url: url
                };
            }
            return responseBody;
        } catch (error) {
            console.error(`API Request failed for ${url}:`, error);
            if (retryCount < maxRetries) {
                const delay = Math.min(this.baseDelay * Math.pow(2, retryCount), 30000);
                console.warn(`Request failed. Retrying after ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.fetchWithRateLimit(url, options, apiKey, retryCount + 1);
            }
            throw error;
        }
    }

    async fetchAbstractFromScopus(scopusId) {
        if (!this.elsevierApiKey) {
            console.warn('Skipping Scopus Abstract Retrieval API call - no API key provided');
            return null;
        }

        try {
            // Remove the 2-s2.0- prefix if present in the Scopus ID
            const cleanScopusId = scopusId.replace('2-s2.0-', '');
            const url = `https://api.elsevier.com/content/abstract/scopus_id/${cleanScopusId}`;

            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'X-ELS-APIKey': this.elsevierApiKey
                }
            });

            if (!response.ok) {
                const errorData = await response.json();
                console.error('Scopus Abstract API Error:', errorData);
                if (response.status === 401) {
                    console.warn('Authentication failed for Scopus Abstract API. Check your API key.');
                    return null;
                }
                if (response.status === 404) {
                    console.warn(`Abstract not found for Scopus ID ${scopusId}`);
                    return null;
                }
                throw new Error(`Scopus Abstract API request failed: ${response.status} - ${errorData['service-error']?.['status']?.['statusText'] || 'Unknown error'}`);
            }

            const data = await response.json();
            const abstract = data['abstracts-retrieval-response']?.coredata?.['dc:description'];
            
            if (!abstract) {
                console.warn(`No abstract content found in Scopus response for ID ${scopusId}`);
                return null;
            }

            console.log(`Successfully retrieved abstract from Scopus for ID ${scopusId}`);
            return abstract;
        } catch (error) {
            console.error(`Error fetching abstract from Scopus for ID ${scopusId}:`, error);
            return null;
        }
    }

    async fetchAbstractFromDOI(doi) {
        if (!this.elsevierApiKey) {
            console.warn('Skipping Scopus Abstract Retrieval API call - no API key provided');
            return null;
        }

        try {
            // First try Scopus Abstract API
            const scopusUrl = `https://api.elsevier.com/content/abstract/doi/${encodeURIComponent(doi)}`;
            const response = await fetch(scopusUrl, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'X-ELS-APIKey': this.elsevierApiKey
                }
            });

            if (response.ok) {
                const data = await response.json();
                const abstract = data['abstracts-retrieval-response']?.coredata?.['dc:description'];
                if (abstract) {
                    console.log('Successfully retrieved abstract from Scopus API');
                    return abstract;
                }
            }

            // If Scopus doesn't have the abstract, try ScienceDirect as fallback
            console.log(`Scopus abstract not found for DOI ${doi}, trying ScienceDirect...`);
            const sciDirUrl = `https://api.elsevier.com/content/article/doi/${encodeURIComponent(doi)}`;
            const headers = {
                'Accept': 'application/json',
                'X-ELS-APIKey': this.elsevierApiKey
            };

            if (this.elsevierInstToken) {
                headers['X-ELS-Insttoken'] = this.elsevierInstToken;
            }

            const sciDirResponse = await fetch(sciDirUrl, {
                method: 'GET',
                headers: headers
            });

            if (!sciDirResponse.ok) {
                if (sciDirResponse.status === 404) {
                    console.warn(`Article not found in ScienceDirect for DOI ${doi}`);
                    return null;
                }
                throw new Error(`ScienceDirect API request failed with status ${sciDirResponse.status}`);
            }

            const sciDirData = await sciDirResponse.json();
            const sciDirAbstract = sciDirData['full-text-retrieval-response']?.coredata?.['dc:description'];
            
            if (!sciDirAbstract) {
                console.warn(`No abstract found in ScienceDirect for DOI ${doi}`);
                return null;
            }

            console.log(`Successfully fetched abstract from ScienceDirect for DOI ${doi}`);
            return sciDirAbstract;
        } catch (error) {
            console.error(`Error fetching abstract for DOI ${doi}:`, error);
            return null;
        }
    }

    async processWithGemini(text, prompt) {
        if (!this.geminiApiKey) {
            throw new Error('Gemini API key is not set');
        }

        return geminiLimiter.addToQueue(async () => {
            await new Promise(resolve => setTimeout(resolve, 2000));

            const model = this.genAI.getGenerativeModel({
                model: "gemini-2.0-flash-thinking-exp-01-21",
            });

            const generationConfig = {
                temperature: 1,
                topP: 0.95,
                topK: 64,
                maxOutputTokens: 8192,
                responseMimeType: "text/plain",
            };

            const chatSession = model.startChat({
                generationConfig,
                history: [],
            });

            try {
                const result = await chatSession.sendMessage(`${prompt}\n\n${text}`);
                console.log('Gemini API Response:', result.response.text());
                return result.response.text();
            } catch (error) {
                console.error('Error in Gemini API call:', error);
                throw error;
            }
        }, 'gemini');
    }
}

class ScopusClient {
    constructor(config = {}) {
        this.apiKey = process.env.ELSEVIER_API_KEY;
        this.searchQuery = config.searchQuery || process.env.SEARCH_QUERY || '"large language model" OR "machine learning"';
        this.maxRetries = config.maxRetries || 3;
        this.baseDelay = config.baseDelay || 2000;
        this.timeout = config.timeout || 30000;
        
        if (!this.apiKey) {
            console.warn('Warning: ELSEVIER_API_KEY not set in environment variables');
            throw new Error('Scopus API key is not set');
        }
        
        console.log('Scopus initialized with query:', this.searchQuery);
    }

    async fetchPapers(maxResults = 20) {
        try {
            const url = new URL('https://api.elsevier.com/content/search/scopus');
            
            // Use advanced search query to include open access content
            const query = `TITLE-ABS-KEY(${this.searchQuery})`;
            url.searchParams.append('query', query);
            url.searchParams.append('apiKey', this.apiKey);
            url.searchParams.append('count', maxResults.toString());
            url.searchParams.append('sort', '-coverDate');
            url.searchParams.append('view', 'STANDARD');
            url.searchParams.append('field', 'dc:identifier,dc:title,dc:creator,prism:coverDate,prism:doi,prism:publicationName');

            const response = await fetch(url.toString(), {
                method: 'GET',
                headers: {
                    'Accept': 'application/json'
                }
            });

            if (!response.ok) {
                const errorData = await response.json();
                console.error('Scopus API Error:', errorData);
                throw new Error(`Scopus API request failed: ${response.status} - ${errorData['error-response']?.['error-message'] || 'Unknown error'}`);
            }

            const data = await response.json();
            const entries = data['search-results']?.entry || [];

            const papers = await Promise.all(entries.map(async entry => {
                return {
                    title: entry['dc:title'] || 'No title available',
                    authors: entry['dc:creator'] || 'No authors available',
                    abstract: 'Abstract not available in Standard view',
                    publicationDate: entry['prism:coverDate'] || 'No date available',
                    doi: entry['prism:doi'] || null,
                    url: `https://doi.org/${entry['prism:doi']}` || null,
                    journal: entry['prism:publicationName'] || 'No journal available',
                    source: 'Scopus'
                };
            }));

            return papers.filter(paper => paper !== null);
        } catch (error) {
            console.error('Error fetching papers from Scopus:', error);
            return [];
        }
    }

    async fetchAbstract(scopusId) {
        try {
            const url = `https://api.elsevier.com/content/abstract/scopus_id/${scopusId}`;
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'X-ELS-APIKey': this.apiKey
                }
            });

            if (!response.ok) {
                console.warn(`Failed to fetch abstract for Scopus ID ${scopusId}`);
                return null;
            }

            const data = await response.json();
            return data['abstracts-retrieval-response']?.coredata?.['dc:description'] || null;
        } catch (error) {
            console.error(`Error fetching abstract for Scopus ID ${scopusId}:`, error);
            return null;
        }
    }
}

class CrossRefClient {
    constructor(options = {}) {
        this.baseDelay = options.baseDelay || 1000;
        this.maxRetries = options.maxRetries || 3;  // リトライ回数を増やす
        this.maxDelay = options.maxDelay || 10000;
        this.lastRequestTime = 0;
        this.minRequestInterval = 500;  // インターバルを増やして安定性を向上
        this.scrapeRetryDelay = 2000;  // スクレイピング時のリトライ遅延
    }

    async sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async enforceRateLimit() {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;

        if (timeSinceLastRequest < this.minRequestInterval) {
            await this.sleep(this.minRequestInterval - timeSinceLastRequest);
        }

        this.lastRequestTime = Date.now();
    }

    async fetchWithRetry(url, options, retryCount = 0) {
        try {
            await this.enforceRateLimit();

            const response = await fetch(url, {
                ...options,
                headers: {
                    ...options.headers,
                    'User-Agent': 'AcademicPaperReader/1.0 (mailto:your@email.com)',
                    'Referer': 'https://api.crossref.org/'
                }
            });

            // レスポンスのログ出力
            console.log(`CrossRef API Response Status: ${response.status} for URL: ${url}`);
            
            if (response.status === 429) {
                if (retryCount >= this.maxRetries) {
                    throw new Error('Max retries exceeded for rate limit');
                }

                const retryAfter = response.headers.get('Retry-After');
                const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 :
                    Math.min(this.baseDelay * Math.pow(2, retryCount), this.maxDelay);

                console.warn(`Rate limited by CrossRef. Retrying after ${delay}ms...`);
                await this.sleep(delay);

                return this.fetchWithRetry(url, options, retryCount + 1);
            }

            if (!response.ok) {
                const errorBody = await response.text();
                console.error(`CrossRef API Error Response: ${errorBody}`);
                
                if (retryCount < this.maxRetries) {
                    const delay = Math.min(this.baseDelay * Math.pow(2, retryCount), this.maxDelay);
                    console.warn(`Request failed with status ${response.status}. Retrying after ${delay}ms...`);
                    await this.sleep(delay);
                    return this.fetchWithRetry(url, options, retryCount + 1);
                }
                
                throw new Error(`HTTP error! status: ${response.status}, body: ${errorBody}`);
            }

            // スクレイピングの前に短いウェイトを入れる
            await this.sleep(1000);
            
            return response;
        } catch (error) {
            if (error.message === 'Max retries exceeded') {
                throw error;
            }

            if (retryCount >= this.maxRetries) {
                throw new Error(`Failed after ${this.maxRetries} retries: ${error.message}`);
            }

            const delay = Math.min(this.baseDelay * Math.pow(2, retryCount), this.maxDelay);
            console.warn(`Request failed. Retrying after ${delay}ms...`);
            await this.sleep(delay);

            return this.fetchWithRetry(url, options, retryCount + 1);
        }
    }

    generatePublisherUrls(doi) {
        const publisherUrls = [];
        
        // Elsevier (ScienceDirect)
        if (doi.startsWith('10.1016')) {
            publisherUrls.push(`https://www.sciencedirect.com/science/article/pii/${doi.split('/')[1]}`);
        }
        
        // Springer
        if (doi.startsWith('10.1007')) {
            publisherUrls.push(`https://link.springer.com/article/${doi}`);
        }
        
        // Wiley
        if (doi.startsWith('10.1111') || doi.startsWith('10.1002')) {
            publisherUrls.push(`https://onlinelibrary.wiley.com/doi/${doi}`);
        }
        
        // IEEE
        if (doi.startsWith('10.1109')) {
            publisherUrls.push(`https://ieeexplore.ieee.org/document/${doi.split('/')[1]}`);
        }

        // Taylor & Francis
        if (doi.startsWith('10.1080')) {
            publisherUrls.push(`https://www.tandfonline.com/doi/full/${doi}`);
        }

        // SAGE
        if (doi.startsWith('10.1177')) {
            publisherUrls.push(`https://journals.sagepub.com/doi/full/${doi}`);
        }

        console.log(`Generated publisher URLs for DOI ${doi}:`, publisherUrls);
        return publisherUrls;
    }

    async fetchCrossRefPapers(searchQuery) {
        try {
            const searchUrl = `https://api.crossref.org/works?query=${encodeURIComponent(searchQuery)}&filter=has-abstract:true&rows=20&sort=published`;
            console.log('Requesting CrossRef papers...');

            const papers = await this.fetchWithRetry(
                searchUrl,
                {
                    headers: {
                        'Accept': 'application/json'
                    }
                }
            );

            const data = await papers.json();
            const items = data.message?.items || [];
            
            // 他のAPIクライアントと同じフォーマットでログを出力
            console.log('Fetched papers from CrossRef:', items);
            console.log(`Retrieved ${items.length} papers out of ${data.message?.['total-results'] || 0} total results`);

            const rawPapers = items.map(paper => ({
                title: paper.title?.[0] || 'No title available',
                author: paper.author ? paper.author.map(a => `${a.given} ${a.family}`).join(', ') : 'No authors available',
                publicationDate: paper.created?.['date-time'] || 'No publication date available',
                abstract: paper.abstract || 'No abstract available',
                journal: paper['container-title']?.[0] || 'No journal available',
                doi: paper.DOI || null,
                link: paper.DOI ? `https://doi.org/${paper.DOI}` : 'No link available'
            })) || [];

            const processedPapers = await Promise.all(rawPapers.map(async paper => {
                if (!paper.abstract || paper.abstract === 'No abstract available') {
                    console.log(`Attempting to fetch abstract for paper: ${paper.title}`);
                    
                    // APIからの抽出を試みる
                    if (paper.doi) {
                        try {
                            const apiUrl = `https://api.crossref.org/works/${encodeURIComponent(paper.doi)}`;
                            console.log(`Fetching from CrossRef API: ${apiUrl}`);
                            const response = await this.fetchWithRetry(apiUrl, {
                                headers: { 'Accept': 'application/json' }
                            });
                            const paperData = await response.json();
                            if (paperData.message?.abstract) {
                                paper.abstract = paperData.message.abstract;
                                console.log('Successfully retrieved abstract from CrossRef API');
                                return paper;
                            }
                        } catch (error) {
                            console.warn(`Failed to fetch abstract from CrossRef API: ${error.message}`);
                        }
                    }

                    // スクレイピングを試みる
                    if (paper.link) {
                        console.log(`Attempting to scrape abstract from ${paper.link}`);
                        let abstract = await webScraper.scrapeAbstractFromUrl(paper.link);
                        
                        if (!abstract && paper.doi) {
                            const publisherUrls = this.generatePublisherUrls(paper.doi);
                            for (const url of publisherUrls) {
                                console.log(`Trying publisher URL: ${url}`);
                                abstract = await webScraper.scrapeAbstractFromUrl(url);
                                if (abstract) {
                                    console.log('Successfully retrieved abstract from publisher URL');
                                    break;
                                }
                            }
                        }
                        
                        if (abstract) {
                            paper.abstract = abstract;
                        }
                    }
                }
                return paper;
            }));

            // 要約が取得できた論文のみをフィルタリング
            const validPapers = processedPapers.filter(paper =>
                paper.abstract && paper.abstract !== 'No abstract available'
            );

            // 詳細なログ出力
            console.log('Fetched papers from CrossRef:', validPapers);
            console.log('CrossRef papers processing summary:');
            console.log(`- Total papers found: ${processedPapers.length}`);
            console.log(`- Papers with abstracts: ${validPapers.length}`);
            console.log(`- Papers without abstracts: ${processedPapers.length - validPapers.length}`);
            
            return validPapers;
        } catch (error) {
            console.error('Error fetching from CrossRef:', error);
            throw error;
        }
    }
}

class PaperProcessor {
    constructor(apiClient) {
        this.apiClient = apiClient;
        this.processedPapers = new Set();
    }

    async fetchPapers() {
        const [crossRefPapers, elsevierPapers, arxivPapers, springerPapers, semanticScholarPapers, pubMedPapers] = await Promise.all([
            this.apiClient.fetchCrossRefPapers(),
            this.apiClient.fetchElsevierPapers(),
            this.apiClient.fetchArxivPapers(20),
            this.apiClient.fetchSpringerPapers(20),
            this.apiClient.fetchSemanticScholarPapers(20),
            this.apiClient.fetchPubMedPapers(20)
        ]);

        const uniquePapers = [];
        const seenDOIs = new Set();

        for (const paper of [...crossRefPapers, ...elsevierPapers, ...arxivPapers, ...springerPapers, ...semanticScholarPapers, ...pubMedPapers]) {
            if (paper.doi && !seenDOIs.has(paper.doi)) {
                seenDOIs.add(paper.doi);
                uniquePapers.push(paper);
            }
        }

        return uniquePapers;
    }

    async filterPapers(papers) {
        const results = [];
        for (const paper of papers) {
            try {
                await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 3000));

                const response = await this.apiClient.processWithGemini(
                    `Title: ${paper.title}\nAbstract: ${paper.abstract}`,
                    this.apiClient.geminiPrompt.replace('${SEARCH_QUERY}', this.apiClient.searchQuery)
                );

                if (response.toLowerCase().includes('yes')) {
                    results.push(paper);
                    console.log(`Paper included: ${paper.title}`);
                } else {
                    console.log(`Paper excluded: ${paper.title}`);
                }
            } catch (error) {
                console.error('Error filtering paper:', error);
                continue;
            }
        }
        return results;
    }

    async translatePapers(papers) {
        const results = [];
        for (const paper of papers) {
            let retryCount = 0;
            const maxRetries = 1;

            while (retryCount < maxRetries) {
                try {
                    await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 3000));

                    if (!paper.abstract && paper.doi) {
                        const abstract = await this.apiClient.fetchAbstractFromDOI(paper.doi);
                        if (abstract) {
                            paper.abstract = abstract;
                            console.log(`Fetched abstract for DOI ${paper.doi}:`, abstract);
                        }
                    }

                    if (paper.abstract && paper.abstract !== 'No abstract available') {
                        const translatedAbstract = await this.apiClient.processWithGemini(
                            paper.abstract,
                            '以下の学術論文の要約を日本語に翻訳してください。翻訳には学術用語を維持し、余計な説明や文章を追加しないでください。\n\n'
                        );
                        console.log(`Translated abstract for DOI ${paper.doi}:`, translatedAbstract);

                        const cleanTranslatedAbstract = translatedAbstract.replace(/^.*?(?=翻訳|日本語訳)/, '').trim();

                        results.push({
                            ...paper,
                            translatedAbstract: cleanTranslatedAbstract || 'No abstract available'
                        });
                        break; // 成功したらループを抜ける
                    } else {
                        console.log(`No abstract available for DOI ${paper.doi}. Skipping translation.`);
                        results.push({
                            ...paper,
                            translatedAbstract: 'No abstract available'
                        });
                        break; // 成功したらループを抜ける
                    }
                } catch (error) {
                    retryCount++;
                    console.error(`Error translating paper (retry ${retryCount} of ${maxRetries}):`, error);
                    if (retryCount >= maxRetries) {
                        console.error('Max retries reached. Skipping translation for this paper.');
                        results.push({
                            ...paper,
                            translatedAbstract: 'No abstract available'
                        });
                    }
                }
            }
        }
        return results;
    }
}

class HTMLRenderer {
    constructor() {
        this.template = fs.readFileSync('template_1.html', 'utf8');
    }

    updateHTML(papers) {
        this.updateIndexHTML(papers);
        this.updateSortedHTMLFiles(papers);
    }

    createPaperCardHTML(paper) {
        const escapeHTML = (str) => {
            if (str == null) return '';
            return String(str)
                .replace(/&/g, '&')
                .replace(/</g, '<')
                .replace(/>/g, '>')
                .replace(/"/g, '"')
                .replace(/'/g, '&#039;')
                .replace(/<jats:p>/g, '')
                .replace(/<\/jats:p>/g, '');
        };

        const formatDate = (dateString) => {
            const date = new Date(dateString);
            return date.toLocaleDateString('ja-JP', {
                year: 'numeric',
                month: 'long',
                day: 'numeric'
            });
        };

        const japaneseAbstract = paper.translatedAbstract || 'No abstract available';
        const paperUrl = paper.link || (paper.doi ? `https://doi.org/${paper.doi}` : '#');

        return `
            <article class="paper-card" 
                data-category="教育・労働経済学" 
                data-title="${escapeHTML(paper.title)}" 
                data-authors="${escapeHTML(paper.author)}" 
                data-journal="${escapeHTML(paper.journal)}" 
                data-date="${formatDate(paper.publicationDate)}" 
                data-abstract="${escapeHTML(paper.abstract)}"
                data-translated-abstract="${escapeHTML(paper.translatedAbstract)}"
                data-doi="${escapeHTML(paper.doi)}"
                data-link="${escapeHTML(paper.link)}">
                <div class="card-content">
                    <div class="paper-category">${escapeHTML(paper.journal)}</div>
                    <h3 class="paper-title">${escapeHTML(paper.title)}</h3>
                    <p class="paper-abstract">${escapeHTML(japaneseAbstract)}</p>
                    <div class="paper-meta">
                        <time>${formatDate(paper.publicationDate)}</time>
                        <button class="modal-action-btn" aria-label="Xへ投稿" onclick="window.location.href='https://twitter.com/intent/tweet?text=' + encodeURIComponent('${escapeHTML(paper.title)}') + '%0A' + encodeURIComponent('${paperUrl}')">Xへの投稿</button>
                        <button class="modal-action-btn" aria-label="論文を開く" onclick="window.location.href='${paperUrl}'">論文を開く</button>
                        <button class="expand-btn" aria-label="詳細を表示">詳細</button>
                    </div>
                </div>
            </article>
        `;
    }

    updateSortedHTMLFiles(papers) {
        try {
            const sortTypes = ['registration', 'acquisition', 'journal', 'publication'];
            const sortFunctions = {
                registration: (a, b) => new Date(b.publicationDate) - new Date(a.publicationDate),
                acquisition: (a, b) => b.index - a.index,
                journal: (a, b) => a.journal.localeCompare(b.journal),
                publication: (a, b) => new Date(b.publicationDate) - new Date(a.publicationDate)
            };

            sortTypes.forEach(sortType => {
                const fileName = `${sortType}.html`;
                
                if (fs.existsSync(fileName)) {
                    let existingContent = fs.readFileSync(fileName, 'utf8');
                    const dom = new JSDOM(existingContent);
                    const doc = dom.window.document;
                    
                    // 既存の論文カードを取得
                    const existingPapers = new Set();
                    const paperCards = doc.querySelectorAll('.paper-card');
                    paperCards.forEach(card => {
                        const title = card.querySelector('.paper-title')?.textContent?.trim().toLowerCase();
                        const doi = card.dataset.doi?.trim().toLowerCase();
                        if (title) existingPapers.add(title);
                        if (doi) existingPapers.add(doi);
                    });

                    // 新しい論文のみをフィルタリング
                    const newPapers = papers.filter(paper => {
                        const paperTitle = paper.title?.trim().toLowerCase();
                        const paperDoi = paper.doi?.trim().toLowerCase();
                        return !existingPapers.has(paperTitle) && !existingPapers.has(paperDoi);
                    });

                    if (newPapers.length > 0) {
                        // ソート順に従って論文を並び替え
                        const sortedPapers = [...newPapers].sort(sortFunctions[sortType]);
                        const newPapersContent = sortedPapers.map(paper => this.createPaperCardHTML(paper)).join('');
                        
                        const updateDate = new Date().toLocaleDateString('ja-JP', {
                            year: 'numeric',
                            month: 'long',
                            day: 'numeric'
                        });

                        const newSection = `
                            <div class="papers-section">
                                <h2 class="date-header">${updateDate}</h2>
                                <div class="papers-grid">
                                    ${newPapersContent}
                                </div>
                            </div>
                        `;

                        const updatedContent = existingContent.replace(
                            '<div class="papers-section">',
                            `${newSection}<div class="papers-section">`
                        );

                        fs.writeFileSync(fileName, updatedContent, 'utf8');
                        console.log(`${fileName} updated successfully`);
                    } else {
                        console.log(`No new papers to add to ${fileName}. Skipping update.`);
                    }
                }
            });
        } catch (error) {
            console.error('Error updating sorted HTML files:', error);
            throw error;
        }
    }

    updateIndexHTML(papers) {
        try {
            const escapeHTML = (str) => {
                if (str == null) {
                    return '';
                }
                return String(str)
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;')
                    .replace(/'/g, '&#039;')
                    .replace(/&lt;jats:p&gt;/g, '')
                    .replace(/&lt;\/jats:p&gt;/g, '');
            };

            const formatDate = (dateString) => {
                const date = new Date(dateString);
                return date.toLocaleDateString('ja-JP', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric'
                });
            };

            let existingContent = '';
            if (fs.existsSync('index.html')) {
                existingContent = fs.readFileSync('index.html', 'utf8');
            }

            const existingPapers = new Set();
            const dom = new JSDOM(existingContent);
            const doc = dom.window.document;
            
            const paperCards = doc.querySelectorAll('.paper-card');
            paperCards.forEach(card => {
                const title = card.querySelector('.paper-title')?.textContent?.trim().toLowerCase();
                const doi = card.dataset.doi?.trim().toLowerCase();
                if (title) {
                    existingPapers.add(title);
                }
                if (doi) {
                    existingPapers.add(doi);
                }
            });

            const newPapersContent = papers
                .filter(paper => {
                    const paperTitle = paper.title?.trim().toLowerCase();
                    const paperDoi = paper.doi?.trim().toLowerCase();
                    return !existingPapers.has(paperTitle) && !existingPapers.has(paperDoi);
                })
                .map((paper, index) => {
                    const japaneseAbstract = paper.translatedAbstract || 'No abstract available';
                    const abstractPreview = japaneseAbstract.substring(0, 200) + '...';

                    let paperUrl = paper.link;
                    if (!paperUrl && paper.doi) {
                        paperUrl = `https://doi.org/${paper.doi}`;
                    }

                    const paperCard = `
                        <article class="paper-card" 
                            data-category="教育・労働経済学" 
                            data-title="${escapeHTML(paper.title)}" 
                            data-authors="${escapeHTML(paper.author)}" 
                            data-journal="${escapeHTML(paper.journal)}" 
                            data-date="${formatDate(paper.publicationDate)}" 
                            data-abstract="${escapeHTML(paper.abstract)}"
                            data-translated-abstract="${escapeHTML(paper.translatedAbstract)}"
                            data-doi="${escapeHTML(paper.doi)}"
                            data-link="${escapeHTML(paper.link)}">
                            <div class="card-content">
                                <div class="paper-category">${escapeHTML(paper.journal)}</div>
                                <h3 class="paper-title">${escapeHTML(paper.title)}</h3>
                                <p class="paper-abstract">${escapeHTML(japaneseAbstract)}</p>
                                <div class="paper-meta">
                                    <time>${formatDate(paper.publicationDate)}</time>
                                    <button class="modal-action-btn" aria-label="Xへ投稿" onclick="window.location.href='https://twitter.com/intent/tweet?text=' + encodeURIComponent('${escapeHTML(paper.title)}') + '%0A' + encodeURIComponent('${paperUrl}')">Xへの投稿</button>
                                    <button class="modal-action-btn" aria-label="論文を開く" onclick="window.location.href='${paperUrl}'">論文を開く</button>
                                    <button class="expand-btn" aria-label="詳細を表示">詳細</button>
                                </div>
                            </div>
                        </article>
                    `;
                    return paperCard;
                }).join('');

            if (newPapersContent.trim() === '') {
                console.log('No new papers to add. Skipping update.');
                return;
            }

            const updateDate = new Date().toLocaleDateString('ja-JP', {
                year: 'numeric',
                month: 'long',
                day: 'numeric'
            });

            const newSection = `
                <div class="papers-section">
                    <h2 class="date-header">${updateDate}</h2>
                    <div class="papers-grid">
                        ${newPapersContent}
                    </div>
                </div>
            `;

            let updatedContent = existingContent.replace(
                '<div class="papers-section">',
                `${newSection}<div class="papers-section">`
            );

            fs.writeFileSync('index.html', updatedContent, 'utf8');
            console.log('index.html updated successfully');
        } catch (error) {
            console.error('Error updating index.html:', error);
            throw error;
        }
    }
}

async function main() {
    try {
        console.log('Initializing application...');

        const apiClient = new APIClient();
        const paperProcessor = new PaperProcessor(apiClient);
        const htmlRenderer = new HTMLRenderer();

        console.log('Fetching papers from APIs...');
        const papers = await paperProcessor.fetchPapers();
        console.log(`Fetched ${papers.length} papers`);

        console.log('Filtering papers...');
        const filteredPapers = await paperProcessor.filterPapers(papers);
        console.log(`Filtered down to ${filteredPapers.length} papers`);

        console.log('Translating papers...');
        const translatedPapers = await paperProcessor.translatePapers(filteredPapers);
        console.log('Translation complete');

        console.log('Updating index.html...');
        await htmlRenderer.updateHTML(translatedPapers);
        console.log('Initialization complete');

        return translatedPapers;
    } catch (error) {
        console.error('Fatal error in main:', error);
        process.exit(1);
    }
}

export {
    RateLimiter,
    APIClient,
    PaperProcessor,
    HTMLRenderer,
    main
};

if (import.meta.url === new URL(import.meta.url).href) {
    main();
}
