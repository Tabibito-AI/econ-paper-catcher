import { JSDOM } from 'jsdom';
import axios from 'axios';

class WebScraper {
    constructor() {
        this.timeout = 10000; // 10秒タイムアウト
        this.retryCount = 3;
        this.retryDelay = 2000;
    }

    async fetchWithRetry(url, retryCount = 0) {
        try {
            const response = await axios.get(url, {
                timeout: this.timeout,
                maxRedirects: 5,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                }
            });
            // リダイレクト後の最終URLを含めて返す
            return {
                data: response.data,
                finalUrl: response.request.res.responseUrl || url
            };
        } catch (error) {
            if (retryCount < this.retryCount) {
                await new Promise(resolve => setTimeout(resolve, this.retryDelay));
                return this.fetchWithRetry(url, retryCount + 1);
            }
            throw error;
        }
    }

    async scrapeAbstractFromUrl(url) {
        try {
            const { data: html, finalUrl } = await this.fetchWithRetry(url);
            const dom = new JSDOM(html);
            const document = dom.window.document;

            // リダイレクト後のURLを使用してスクレイピング対象を判断
            const targetUrl = finalUrl || url;
            console.log(`Scraping abstract from final URL: ${targetUrl}`);

            // ScienceDirect用のスクレイピング（DOIからのリダイレクトも含む）
            if (targetUrl.includes('sciencedirect.com')) {
                // 複数のセレクタを試行
                const selectors = [
                    'section.abstract',
                    'div.abstract.author',
                    'div[class*="abstract"]',
                    '#abstracts',
                    '#abstract_sec'
                ];

                for (const selector of selectors) {
                    const element = document.querySelector(selector);
                    if (element) {
                        const abstractText = element.textContent?.trim();
                        if (abstractText) {
                            const cleaned = abstractText.replace(/^Abstract\s*/i, '').trim();
                            console.log(`Successfully scraped abstract from ScienceDirect using selector: ${selector}`);
                            return cleaned;
                        }
                    }
                }
            }

            // arXiv用のスクレイピング
            if (targetUrl.includes('arxiv.org')) {
                const abstract = document.querySelector('.abstract')?.textContent?.trim();
                if (abstract) {
                    const cleaned = abstract.replace('Abstract:', '').trim();
                    console.log(`Successfully scraped abstract from arXiv`);
                    return cleaned;
                }
            }

            // Springer用のスクレイピング
            if (targetUrl.includes('springer.com') || targetUrl.includes('link.springer.com')) {
                const abstract = document.querySelector('.Abstract')?.textContent?.trim() ||
                    document.querySelector('.c-article-section__content')?.textContent?.trim();
                if (abstract) {
                    console.log(`Successfully scraped abstract from Springer`);
                    return abstract;
                }
            }

            // Semantic Scholar用のスクレイピング
            if (targetUrl.includes('semanticscholar.org')) {
                const abstract = document.querySelector('.abstract__text')?.textContent?.trim();
                if (abstract) {
                    console.log(`Successfully scraped abstract from Semantic Scholar`);
                    return abstract;
                }
            }

            // PubMed用のスクレイピング
            if (targetUrl.includes('pubmed.ncbi.nlm.nih.gov')) {
                // 主要なabstractセレクタ
                const abstract = document.querySelector('#enc-abstract')?.textContent?.trim() ||
                    document.querySelector('.abstract-content')?.textContent?.trim() ||
                    document.querySelector('.abstract')?.textContent?.trim();

                // 取得したabstractが有効かチェック
                if (abstract && !/(object|Object)/i.test(abstract)) {
                    console.log(`Successfully scraped abstract from PubMed`);
                    return abstract;
                }

                // フォールバック: メタデータからの抽出
                const metaAbstract = document.querySelector('meta[name="citation_abstract"]')?.content?.trim();
                if (metaAbstract && !/(object|Object)/i.test(metaAbstract)) {
                    console.log(`Found abstract in meta tag`);
                    return metaAbstract;
                }

                // 最終フォールバック: 全文からabstractを推測
                const fullText = document.body.textContent;
                if (fullText) {
                    // 最初の2段落をabstractとして使用
                    const paragraphs = fullText.split('\n').filter(p => p.trim().length > 0);
                    const potentialAbstract = paragraphs.slice(0, 2).join(' ').trim();
                    if (potentialAbstract && !/(object|Object)/i.test(potentialAbstract)) {
                        console.log(`Extracted potential abstract from full text`);
                        return potentialAbstract;
                    }
                }

                console.warn(`No valid abstract found for PubMed URL: ${targetUrl}`);
                return 'No abstract available from web scraping';
            }

            // Scopus用のスクレイピング
            if (targetUrl.includes('scopus.com') || targetUrl.includes('elsevier.com')) {
                // 主要なabstractセレクタ
                const abstract = document.querySelector('.abstractSection')?.textContent?.trim() ||
                    document.querySelector('.abstract')?.textContent?.trim() ||
                    document.querySelector('.Abstract')?.textContent?.trim() ||
                    document.querySelector('.abstract-content')?.textContent?.trim();

                // 取得したabstractが有効かチェック
                if (abstract && !/(object|Object)/i.test(abstract)) {
                    console.log(`Successfully scraped abstract from Scopus/Elsevier`);
                    return abstract;
                }

                // フォールバック: メタデータからの抽出
                const metaAbstract = document.querySelector('meta[name="citation_abstract"]')?.content?.trim() ||
                    document.querySelector('meta[name="description"]')?.content?.trim();
                if (metaAbstract && !/(object|Object)/i.test(metaAbstract)) {
                    console.log(`Found abstract in meta tag`);
                    return metaAbstract;
                }

                // 最終フォールバック: 全文からabstractを推測
                const fullText = document.body.textContent;
                if (fullText) {
                    // 最初の2段落をabstractとして使用
                    const paragraphs = fullText.split('\n').filter(p => p.trim().length > 0);
                    const potentialAbstract = paragraphs.slice(0, 2).join(' ').trim();
                    if (potentialAbstract && !/(object|Object)/i.test(potentialAbstract)) {
                        console.log(`Extracted potential abstract from full text`);
                        return potentialAbstract;
                    }
                }

                console.warn(`No valid abstract found for Scopus/Elsevier URL: ${targetUrl}`);
                return 'No abstract available from web scraping';
            }

            // DOI直接アクセス用のスクレイピング
            if (targetUrl.includes('doi.org')) {
                // DOIページから一般的なabstract要素を探す
                const abstractSelectors = [
                    '.abstract',
                    '.abstract-content',
                    '[class*="abstract"]',
                    '[id*="abstract"]'
                ];

                for (const selector of abstractSelectors) {
                    const element = document.querySelector(selector);
                    if (element) {
                        const abstractText = element.textContent?.trim();
                        if (abstractText) {
                            const cleaned = abstractText.replace(/^Abstract\s*/i, '').trim();
                            console.log(`Successfully scraped abstract from DOI using selector: ${selector}`);
                            return cleaned;
                        }
                    }
                }
            }

            // メタデータからの抽出を試みる（フォールバック）
            const metaSelectors = [
                'meta[name="description"]',
                'meta[name="citation_abstract"]',
                'meta[property="og:description"]'
            ];

            for (const selector of metaSelectors) {
                const metaElement = document.querySelector(selector);
                if (metaElement?.content) {
                    console.log(`Found abstract in meta tag: ${selector}`);
                    return metaElement.content.trim();
                }
            }

            console.warn(`No abstract found for URL: ${targetUrl}`);
            return 'No abstract available from web scraping';
        } catch (error) {
            console.error(`Error scraping abstract from ${targetUrl} (original: ${url}):`, error);
            if (error.response) {
                console.error(`Status: ${error.response.status}`);
                console.error(`Headers:`, error.response.headers);
            }
            return 'No abstract available from web scraping - Error occurred';
        }
    }
}

export default WebScraper;
