// Import required modules
const Adapter = require('../../model/adapter');
const puppeteer = require('puppeteer');
const PCR = require('puppeteer-chromium-resolver');
const cheerio = require('cheerio');
const { Web3Storage, File } = require('web3.storage');
const Data = require('../../model/data');
const { namespaceWrapper } = require('../../namespaceWrapper');

/**
 * Twitter
 * @class
 * @extends Adapter
 * @description
 * Provides a crawler interface for the data gatherer nodes to use to interact with twitter
 */

class Twitter extends Adapter {
  constructor(credentials, db, maxRetry) {
    super(credentials, maxRetry);
    this.credentials = credentials;
    this.db = new Data('db', []);
    this.db.initializeData();
    this.proofs = new Data('proofs', []);
    this.proofs.initializeData();
    this.cids = new Data('cids', []);
    this.cids.initializeData();
    this.toCrawl = [];
    this.parsed = {};
    this.lastSessionCheck = null;
    this.sessionValid = false;
    this.browser = null;
  }

  /**
   * checkSession
   * @returns {Promise<boolean>}
   * @description
   * 1. Check if the session is still valid
   * 2. If the session is still valid, return true
   * 3. If the session is not valid, check if the last session check was more than 1 minute ago
   * 4. If the last session check was more than 1 minute ago, negotiate a new session
   */
  checkSession = async () => {
    if (this.sessionValid) {
      return true;
    } else if (Date.now() - this.lastSessionCheck > 60000) {
      await this.negotiateSession();
      return true;
    } else {
      return false;
    }
  };

  /**
   * negotiateSession
   * @returns {Promise<void>}
   * @description
   * 1. Get the path to the Chromium executable
   * 2. Launch a new browser instance
   * 3. Open a new page
   * 4. Set the viewport size
   * 5. Queue twitterLogin()
   */
  negotiateSession = async () => {
    const options = {};
    const stats = await PCR(options);

    this.browser = await stats.puppeteer.launch({
      headless: false,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
      executablePath: stats.executablePath,
    });

    console.log('Step: Open new page');
    this.page = await this.browser.newPage();

    // TODO - Enable console logs in the context of the page and export them for diagnostics here
    await this.page.setViewport({ width: 1920, height: 25000 });
    // await this.twitterLogin();
    this.sessionValid = true
    this.lastSessionCheck = Date.now();
    return true;
  };

  /**
   * twitterLogin
   * @returns {Promise<void>}
   * @description
   * 1. Go to twitter.com
   * 2. Go to login page
   * 3. Fill in username
   * 4. Fill in password
   * 5. Click login
   * 6. Wait for login to complete
   * 7. Check if login was successful
   * 8. If login was successful, return true
   * 9. If login was unsuccessful, return false
   * 10. If login was unsuccessful, try again
   */
  twitterLogin = async () => {
    console.log('Step: Go to twitter.com');
    // console.log('isBrowser?', this.browser, 'isPage?', this.page);
    await this.page.goto('https://twitter.com');

    console.log('Step: Go to login page');
    await this.page.goto('https://twitter.com/i/flow/login');

    console.log('Step: Fill in username');
    console.log(this.credentials.username);

    await this.page.waitForSelector('input[autocomplete="username"]');
    await this.page.type(
      'input[autocomplete="username"]',
      this.credentials.username,
    );
    await this.page.keyboard.press('Enter');

    const twitter_verify = await this.page
      .waitForSelector('input[data-testid="ocfEnterTextTextInput"]', {
        timeout: 5000,
        visible: true,
      })
      .then(() => true)
      .catch(() => false);

    if (twitter_verify) {
      await this.page.type(
        'input[data-testid="ocfEnterTextTextInput"]',
        this.credentials.username,
      );
      await this.page.keyboard.press('Enter');
    }

    console.log('Step: Fill in password');
    const currentURL = await this.page.url();
    await this.page.waitForSelector('input[name="password"]');
    await this.page.type('input[name="password"]', this.credentials.password);
    console.log('Step: Click login button');
    await this.page.keyboard.press('Enter');

    // TODO - catch unsuccessful login and retry up to query.maxRetry
    if (!(await this.isPasswordCorrect(this.page, currentURL))) {
      console.log('Password is incorrect.');
      this.sessionValid = false;
    } else if (await this.isEmailVerificationRequired(this.page)) {
      console.log('Email verification required.');
      this.sessionValid = false;
      await this.page.waitForTimeout(1000);
    } else {
      console.log('Password is correct.');
      this.page.waitForNavigation({ waitUntil: 'load' });
      await this.page.waitForTimeout(1000);

      this.sessionValid = true;
      this.lastSessionCheck = Date.now();

      console.log('Step: Login successful');
    }

    return this.sessionValid;
  };

  isPasswordCorrect = async (page, currentURL) => {
    await this.page.waitForTimeout(2000);

    const newURL = await this.page.url();
    if (newURL === currentURL) {
      return false;
    }
    return true;
  };

  isEmailVerificationRequired = async page => {
    // Wait for some time to allow the page to load the required elements
    await page.waitForTimeout(2000);

    // Check if the specific text is present on the page
    const textContent = await this.page.evaluate(
      () => document.body.textContent,
    );
    return textContent.includes(
      'Verify your identity by entering the email address associated with your X account.',
    );
  };

  /**
   * getSubmissionCID
   * @param {string} round - the round to get the submission cid for
   * @returns {string} - the cid of the submission
   * @description - this function should return the cid of the submission for the given round
   * if the submission has not been uploaded yet, it should upload it and return the cid
   */
  getSubmissionCID = async round => {
    if (this.proofs) {
      // we need to upload proofs for that round and then store the cid
      const data = await this.cids.getList({ round: round });
      console.log(`got cids list for round ${round}`, data);

      if (data && data.length === 0) {
        console.log('No cids found for round ' + round);
        return null;
      } else {
        const listBuffer = Buffer.from(JSON.stringify(data));
        const listFile = new File([listBuffer], 'data.json', {
          type: 'application/json',
        });
        // TEST USE
        const client = makeStorageClient();
        const cid = await client.put([listFile]);
        // const cid = "cid"
        await this.proofs.create({
          id: 'proof:' + round,
          proof_round: round,
          proof_cid: cid,
        });

        console.log('returning proof cid for submission', cid);
        return cid;
      }
    } else {
      throw new Error('No proofs database provided');
    }
  };

  /**
   * parseItem
   * @param {string} url - the url of the item to parse
   * @param {object} query - the query object to use for parsing
   * @returns {object} - the parsed item
   * @description - this function should parse the item at the given url and return the parsed item data
   *               according to the query object and for use in either crawl() or validate()
   */
  parseItem = async item => {
    if (this.sessionValid == false) {
      await this.negotiateSession();
    }
    try {
      const $ = cheerio.load(item);
      let data = {};

      const articles = $('article[data-testid="tweet"]').toArray();
      const el = articles[0];
      const tweetUrl = $('a[href*="/status/"]').attr('href');
      const tweetId = tweetUrl.split('/').pop();
      const screen_name = $(el).find('a[tabindex="-1"]').text();
      const allText = $(el).find('a[role="link"]').text();
      const user_name = allText.split('@')[0];
      // console.log('user_name', user_name);
      const user_url =
        'https://twitter.com' + $(el).find('a[role="link"]').attr('href');
      const user_img = $(el).find('img[draggable="true"]').attr('src');

      const tweet_text = $(el)
        .find('div[data-testid="tweetText"]')
        .first()
        .text();

      const outerMediaElements = $(el).find('div[data-testid="tweetText"] a');

      const outer_media_urls = [];
      const outer_media_short_urls = [];

      outerMediaElements.each(function () {
        const fullURL = $(this).attr('href');
        const shortURL = $(this).text().replace(/\s/g, '');

        // Ignore URLs containing "/search?q=" or "twitter.com"
        if (
          fullURL &&
          !fullURL.includes('/search?q=') &&
          !fullURL.includes('twitter.com') &&
          !fullURL.includes('/hashtag/')
        ) {
          outer_media_urls.push(fullURL);
          outer_media_short_urls.push(shortURL);
        }
      });

      const timeRaw = $(el).find('time').attr('datetime');
      const time = await this.convertToTimestamp(timeRaw);
      const tweet_record = $(el).find(
        'span[data-testid="app-text-transition-container"]',
      );
      const commentCount = tweet_record.eq(0).text();
      const likeCount = tweet_record.eq(1).text();
      const shareCount = tweet_record.eq(2).text();
      const viewCount = tweet_record.eq(3).text();
      if (screen_name && tweet_text) {
        data = {
          user_name: user_name,
          screen_name: screen_name,
          user_url: user_url,
          user_img: user_img,
          tweets_id: tweetId,
          tweets_content: tweet_text.replace(/\n/g, '<br>'),
          time_post: time,
          time_read: Date.now(),
          comment: commentCount,
          like: likeCount,
          share: shareCount,
          view: viewCount,
          outer_media_url: outer_media_urls,
          outer_media_short_url: outer_media_short_urls,
        };
      }
      return data;
    } catch (e) {
      console.log('Filtering advertisement tweets; continuing to the next item.');
    }
  };

  convertToTimestamp = async dateString => {
    const date = new Date(dateString);
    return Math.floor(date.getTime() / 1000);
  };

  /**
   * crawl
   * @param {string} query
   * @returns {Promise<string[]>}
   * @description Crawls the queue of known links
   */
  crawl = async query => {
    while (true) {
      console.log('valid? ', this.sessionValid);
      if (this.sessionValid == true) {
        await this.fetchList(query.query, query.round);
        await new Promise(resolve => setTimeout(resolve, 300000)); // If the error message is found, wait for 5 minutes, refresh the page, and continue
      } else {
        await this.negotiateSession();
      }
    }
  };

  /**
   * fetchList
   * @param {string} url
   * @returns {Promise<string[]>}
   * @description Fetches a list of links from a given url
   */
  fetchList = async (url, round) => {
    console.log('fetching list for ', url);

    // Go to the hashtag page
    await this.page.waitForTimeout(1000);
    await this.page.setViewport({ width: 1024, height: 4000 });
    await this.page.goto(url);

    // Wait an additional 5 seconds until fully loaded before scraping
    await this.page.waitForTimeout(5000);

    while (true) {
      round = await namespaceWrapper.getRound();
      // Check if the error message is present on the page inside an article element
      const errorMessage = await this.page.evaluate(() => {
        const elements = document.querySelectorAll('div[dir="ltr"]');
        for (let element of elements) {
          console.log(element.textContent);
          if (element.textContent === 'Something went wrong. Try reloading.') {
            return true;
          }
        }
        return false;
      });

      // Scrape the tweets
      const items = await this.page.evaluate(() => {
        const elements = document.querySelectorAll('article[aria-labelledby]');
        return Array.from(elements).map(element => element.outerHTML);
      });

      for (const item of items) {
        try {
          let data = await this.parseItem(item);
          // console.log(data);
          if (data.tweets_id) {
            // Check if id exists in database
            let checkItem = {
              id: data.tweets_id,
            };
            const existingItem = await this.db.getItem(checkItem);
            if (!existingItem) {
              // Store the item in the database
              const files = await makeFileFromObjectWithName(data, item);
              const cid = await storeFiles(files);
              // const cid = 'testcid';
              this.cids.create({
                id: data.tweets_id,
                round: round,
                cid: cid,
              });
            }
          }
        } catch (e) {
          console.log('Filtering advertisement tweets; continuing to the next item.');
        }
      }

      // Scroll the page for next batch of elements
      await this.scrollPage(this.page);

      // Optional: wait for a moment to allow new elements to load
      await this.page.waitForTimeout(1000);

      // Refetch the elements after scrolling
      await this.page.evaluate(() => {
        return document.querySelectorAll('article[aria-labelledby]');
      });

      // If the error message is found, wait for 2 minutes, refresh the page, and continue
      if (errorMessage) {
        console.log('Rate limit reach, waiting for 5 minutes...');
        this.sessionValid = false;
        await this.browser.close(); // Refresh the page
        break;
      }
    }
    return;
  };

  scrollPage = async page => {
    await page.evaluate(() => {
      window.scrollBy(0, window.innerHeight);
    });
    await page.waitForTimeout(1000); // Adjust the timeout as necessary
  };

  /**
   * processLinks
   * @param {string[]} links
   * @returns {Promise<void>}
   * @description Processes a list of links
   * @todo Implement this function
   * @todo Implement a way to queue links
   */
  processLinks = async links => {
    links.forEach(link => {});
  };

  /**
   * stop
   * @returns {Promise<boolean>}
   * @description Stops the crawler
   */
  stop = async () => {
    return (this.break = true);
  };
}

module.exports = Twitter;

// TODO - move the following functions to a utils file?
function makeStorageClient() {
  return new Web3Storage({ token: getAccessToken() });
}

async function makeFileFromObjectWithName(obj, item) {
  const databuffer = Buffer.from(JSON.stringify(obj));
  const dataJson = new File([databuffer], 'data.json', {
    type: 'application/json',
  });

  const htmlBuffer = Buffer.from(item);
  const dataHtml = new File([htmlBuffer], 'data.txt', {
    type: 'text/html;charset=UTF-8',
  });

  return { dataJson, dataHtml };
}

async function storeFiles(files) {
  const client = makeStorageClient();
  const cid = await client.put([files.dataJson, files.dataHtml]);
  // console.log('stored files with cid:', cid);
  return cid;
}

function getAccessToken() {
  // If you're just testing, you can paste in a token
  // and uncomment the following line:
  // return 'paste-your-token-here'

  // In a real app, it's better to read an access token from an
  // environement variable or other configuration that's kept outside of
  // your code base. For this to work, you need to set the
  // WEB3STORAGE_TOKEN environment variable before you run your code.
  return process.env.WEB3STORAGE_TOKEN;
}
