const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// Добавляем плагин stealth для обхода защиты
puppeteer.use(StealthPlugin());

const app = express();
const PORT = 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('./'));

// Главный парсер
async function parseOzonProducts(searchQuery) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();
    
    // Имитируем реальный браузер
    await page.setViewport({ width: 1366, height: 768 });
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    
    // Отключаем headless mode признаки
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
      });
    });

    const searchUrl = `https://www.ozon.ru/search/?text=${encodeURIComponent(searchQuery)}`;
    console.log(`Парсю: ${searchUrl}`);

    try {
      await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 40000 });
    } catch (e) {
      console.log('Первый переход не прошёл, пробую ещё раз...');
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 40000 });
    }

    // Даём странице время на загрузку контента
    await new Promise(resolve => setTimeout(resolve, 4000));

    // Проверяем, не блокирован ли доступ
    const isBlocked = await page.evaluate(() => {
      const html = document.body.innerHTML;
      return html.includes('Доступ ограничен') || 
             html.includes('Please, enable JavaScript') ||
             html.includes('not a robot');
    });

    if (isBlocked) {
      throw new Error('Озон обнаружил автоматический доступ и заблокировал IP. Попробуйте позже или используйте VPN.');
    }

    // Скроллим до конца для подгрузки товаров
    let prevHeight = 0;
    for (let i = 0; i < 7; i++) {
      const newHeight = await page.evaluate('document.body.scrollHeight');
      if (newHeight === prevHeight) break;
      await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
      await new Promise(resolve => setTimeout(resolve, 2500));
      prevHeight = newHeight;
    }

    // Вытаскиваем ссылки на товары
    const productLinks = await page.evaluate(() => {
      const links = new Set();
      
      // Ищем все ссылки на товары
      document.querySelectorAll('a').forEach(a => {
        const href = a.getAttribute('href');
        if (href && href.match(/\/product\/\d+/)) {
          links.add(href);
        }
      });

      return Array.from(links).slice(0, 20); // Макс 20 товаров
    });

    console.log(`Найдено ${productLinks.length} товаров`);

    const results = [];

    // Парсим каждый товар
    for (let i = 0; i < productLinks.length; i++) {
      try {
        console.log(`Обрабатываю товар ${i + 1}/${productLinks.length}`);
        const productData = await parseProductPage(page, productLinks[i]);
        if (productData) {
          results.push(productData);
        }
        await new Promise(resolve => setTimeout(resolve, 1500));
      } catch (err) {
        console.error(`Ошибка при парсинге товара ${i}:`, err.message);
      }
    }

    await browser.close();
    return results;
  } catch (error) {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {}
    }
    throw error;
  }
}

// Парсинг одного товара
async function parseProductPage(page, productUrl) {
  try {
    let fullUrl = productUrl;
    if (!fullUrl.startsWith('http')) {
      fullUrl = 'https://www.ozon.ru' + productUrl;
    }

    await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 2000));

    const data = await page.evaluate(() => {
      const titleEl = document.querySelector('h1');
      const title = titleEl?.innerText?.trim() || 'N/A';

      // Магазин
      let shop = 'Озон';
      const shopEl = document.querySelector('[class*="seller"]');
      if (shopEl) shop = shopEl.innerText?.trim() || 'Озон';

      // Цена
      let priceWithCard = 'N/A';
      const priceEl = document.querySelector('[class*="price"]');
      if (priceEl) {
        const text = priceEl.innerText?.trim();
        priceWithCard = text || 'N/A';
      }

      let priceWithoutCard = 'N/A';
      const prices = document.querySelectorAll('[class*="price"]');
      if (prices.length > 1) {
        priceWithoutCard = prices[1].innerText?.trim() || 'N/A';
      }

      // Рейтинг
      let rating = 'N/A';
      const ratingEl = document.querySelector('[class*="rating"]');
      if (ratingEl) {
        rating = ratingEl.innerText?.trim() || 'N/A';
      }

      // Отзывы
      let reviews = '0';
      const reviewsEl = document.querySelector('a[href*="reviews"]');
      if (reviewsEl) {
        const text = reviewsEl.innerText;
        const match = text?.match(/\d+/);
        reviews = match ? match[0] : '0';
      }

      return { title, shop, priceWithCard, priceWithoutCard, rating, reviews };
    });

    data.url = fullUrl;
    return data;
  } catch (err) {
    console.error(`Ошибка парсинга товара:`, err.message);
    return null;
  }
}

// API endpoint
app.post('/api/parse', async (req, res) => {
  const { query } = req.body;

  if (!query || query.trim() === '') {
    return res.status(400).json({ error: 'Введите поисковый запрос' });
  }

  try {
    console.log(`Начинаю парсинг для: ${query}`);
    const results = await parseOzonProducts(query);
    res.json({ success: true, data: results, count: results.length });
  } catch (error) {
    console.error('Ошибка при парсинге:', error.message);
    res.status(500).json({
      success: false,
      error: error.message || 'Ошибка при парсинге Озона',
    });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Сервер запущен на http://localhost:${PORT}`);
});
