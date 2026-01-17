// YouTube Language Filter - Content Script
// Supports both Watch pages (/watch) and Shorts pages (/shorts/*)
// Key challenge: YouTube is a SPA, so we must handle dynamic navigation and DOM changes
(function() {
  'use strict';

  // ===========================================
  // DEFAULT SETTINGS
  // ===========================================
  const DEFAULT_SETTINGS = {
    enabled: true,
    allowedLangs: ['en'],
    mode: 'hide',
    hideUnknown: false
  };

  let settings = { ...DEFAULT_SETTINGS };

  // ===========================================
  // CACHES AND STATE
  // ===========================================
  const langCache = new Map();
  const originalContent = new WeakMap();

  // Processing state
  let isProcessing = false;
  let pendingComments = [];
  let processTimeout = null;

  // Observer references - must be cleaned up on re-init
  let commentObserver = null;
  let rootObserver = null;
  let urlCheckInterval = null;

  // Track current state
  let lastUrl = '';
  let currentPageType = null;
  let isInitialized = false;

  /**
   * Generation ID for async operation invalidation.
   * "Extension context invalidated" error happens when:
   * - chrome.i18n.detectLanguage callback fires after the content script context was destroyed
   * - This occurs during SPA navigation or extension reload
   *
   * By tracking a generation ID, we can discard stale async results:
   * - Each RESCAN/navigation increments generationId
   * - Async operations capture the current generationId
   * - When results arrive, if generationId changed, we ignore the result
   */
  let generationId = 0;

  // ===========================================
  // CONSTANTS
  // ===========================================
  const DEBOUNCE_MS = 200;
  const BATCH_SIZE = 20;
  const SAMPLE_LENGTH = 200;
  const URL_CHECK_INTERVAL_MS = 500;

  // CSS classes
  const CLASS_HIDDEN = 'ylf-hidden';
  const CLASS_COLLAPSED = 'ylf-collapsed';
  const CLASS_PLACEHOLDER = 'ylf-placeholder';
  const CLASS_PROCESSED = 'ylf-processed';
  const DATA_PROCESSED = 'data-ylf-processed';

  // ===========================================
  // UNICODE RANGES FOR SCRIPT DETECTION
  // ===========================================
  const HANGUL_REGEX = /[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]/g;
  const HIRAGANA_REGEX = /[\u3040-\u309F]/g;
  const KATAKANA_REGEX = /[\u30A0-\u30FF\u31F0-\u31FF]/g;
  const HAN_REGEX = /[\u4E00-\u9FFF]/g;
  const LATIN_REGEX = /[A-Za-z]/g;
  const URL_REGEX = /https?:\/\/[^\s]+/g;

  // ===========================================
  // RUNTIME CONTEXT VALIDATION
  // ===========================================
  /**
   * Checks if the extension runtime context is still valid.
   * Returns false if the context has been invalidated (e.g., extension reloaded).
   */
  function isRuntimeValid() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  /**
   * Starts a new generation - call this before any rescan/reprocess operation.
   * Returns the new generation ID for tracking async operations.
   */
  function newGeneration() {
    generationId++;
    return generationId;
  }

  /**
   * Checks if a generation ID is still current.
   * Used to discard stale async results.
   */
  function isCurrentGeneration(gen) {
    return gen === generationId;
  }

  // ===========================================
  // PAGE TYPE DETECTION
  // ===========================================
  function detectPageType() {
    const path = window.location.pathname;
    if (path.startsWith('/watch')) return 'watch';
    if (path.startsWith('/shorts')) return 'shorts';
    return null;
  }

  // ===========================================
  // COMMENT CONTAINER DISCOVERY
  // ===========================================
  function findCommentsRoot(pageType) {
    if (pageType === 'watch') {
      return document.querySelector('#comments') ||
             document.querySelector('ytd-comments') ||
             document.querySelector('#content.ytd-comments');
    }

    if (pageType === 'shorts') {
      return document.querySelector('ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-comments-section"]') ||
             document.querySelector('ytd-engagement-panel-section-list-renderer[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"]') ||
             document.querySelector('#engagement-panel-comments-section') ||
             document.querySelector('ytd-comments#comments');
    }

    return null;
  }

  function getCommentSelectors() {
    return 'ytd-comment-thread-renderer, ytd-comment-renderer';
  }

  function isCommentElement(element) {
    const tagName = element.tagName?.toLowerCase();
    return tagName === 'ytd-comment-thread-renderer' ||
           tagName === 'ytd-comment-renderer';
  }

  // ===========================================
  // SCRIPT-BASED HEURISTIC LANGUAGE CLASSIFIER
  // ===========================================
  function heuristicDetect(text) {
    let normalized = text.replace(URL_REGEX, '').trim();

    const hangulMatches = normalized.match(HANGUL_REGEX) || [];
    const hiraganaMatches = normalized.match(HIRAGANA_REGEX) || [];
    const katakanaMatches = normalized.match(KATAKANA_REGEX) || [];
    const hanMatches = normalized.match(HAN_REGEX) || [];
    const latinMatches = normalized.match(LATIN_REGEX) || [];

    const hangulCount = hangulMatches.length;
    const hiraganaCount = hiraganaMatches.length;
    const katakanaCount = katakanaMatches.length;
    const kanaCount = hiraganaCount + katakanaCount;
    const hanCount = hanMatches.length;
    const latinCount = latinMatches.length;

    const totalScriptChars = hangulCount + kanaCount + hanCount + latinCount;

    if (totalScriptChars < 2) {
      return { lang: 'unknown', confidence: 'low' };
    }

    const hangulRatio = hangulCount / totalScriptChars;
    const kanaRatio = kanaCount / totalScriptChars;
    const hanRatio = hanCount / totalScriptChars;
    const latinRatio = latinCount / totalScriptChars;

    // Korean detection
    if (hangulCount >= 2 && (hangulRatio >= 0.20 || hangulCount > kanaCount)) {
      return { lang: 'ko', confidence: 'high' };
    }
    if (hangulCount >= 1 && kanaCount === 0 && hanCount === 0) {
      return { lang: 'ko', confidence: 'medium' };
    }

    // Japanese detection - ONLY if kana exists and no Hangul
    if (kanaCount >= 2 && hangulCount === 0) {
      if (kanaRatio >= 0.10) {
        return { lang: 'ja', confidence: 'high' };
      }
    }
    if (kanaCount >= 1 && hangulCount >= 1) {
      return { lang: 'uncertain', confidence: 'low' };
    }

    // Chinese detection
    if (hanCount >= 2 && hangulCount === 0 && kanaCount === 0) {
      if (hanRatio >= 0.30 || (hanRatio >= 0.20 && latinRatio < 0.50)) {
        return { lang: 'zh', confidence: 'medium' };
      }
    }

    // English/Latin detection
    if (latinRatio >= 0.30 && hangulCount === 0 && kanaCount === 0 && hanCount === 0) {
      return { lang: 'en', confidence: 'high' };
    }
    if (latinRatio >= 0.50 && (hangulCount + kanaCount + hanCount) <= 1) {
      return { lang: 'en', confidence: 'medium' };
    }

    // Mixed Han + Latin
    if (hanCount >= 1 && latinCount >= 1 && hangulCount === 0 && kanaCount === 0) {
      if (hanRatio > latinRatio) {
        return { lang: 'zh', confidence: 'low' };
      }
      return { lang: 'uncertain', confidence: 'low' };
    }

    return { lang: 'uncertain', confidence: 'low' };
  }

  // ===========================================
  // SAFE CHROME LANGUAGE DETECTION WRAPPER
  // ===========================================
  /**
   * Safely calls chrome.i18n.detectLanguage with generation checking.
   * Prevents "Extension context invalidated" errors from crashing the pipeline.
   *
   * @param {string} sample - Text to analyze
   * @param {number} gen - Generation ID when this call was initiated
   * @returns {Promise<{languages: Array}|null>} - Detection result or null if stale/error
   */
  function safeDetectLanguage(sample, gen) {
    return new Promise((resolve) => {
      // Check if runtime is valid before calling
      if (!isRuntimeValid()) {
        resolve(null);
        return;
      }

      try {
        chrome.i18n.detectLanguage(sample, (result) => {
          // Check if this result is still relevant
          if (!isCurrentGeneration(gen)) {
            // Generation changed while we were waiting - discard result
            resolve(null);
            return;
          }

          // Check for runtime errors
          if (chrome.runtime.lastError) {
            // Context invalidated or other error - gracefully fail
            resolve(null);
            return;
          }

          resolve(result);
        });
      } catch (error) {
        // Extension context invalidated
        resolve(null);
      }
    });
  }

  // ===========================================
  // HYBRID LANGUAGE DETECTION
  // ===========================================
  async function detectLanguage(text, gen) {
    const cacheKey = text.substring(0, 100);
    if (langCache.has(cacheKey)) {
      return langCache.get(cacheKey);
    }

    const heuristic = heuristicDetect(text);

    if (heuristic.lang !== 'uncertain' && heuristic.lang !== 'unknown') {
      const result = {
        lang: heuristic.lang,
        isUnknown: false,
        confidence: heuristic.confidence
      };
      langCache.set(cacheKey, result);
      return result;
    }

    if (heuristic.lang === 'unknown') {
      const result = { lang: 'unknown', isUnknown: true, confidence: 'low' };
      langCache.set(cacheKey, result);
      return result;
    }

    // Fallback to chrome.i18n.detectLanguage with safety wrapper
    const sample = text.substring(0, SAMPLE_LENGTH);
    const chromeResult = await safeDetectLanguage(sample, gen);

    // If null, detection was stale or failed - return unknown
    if (!chromeResult) {
      const result = { lang: 'unknown', isUnknown: true, confidence: 'low' };
      // Don't cache stale results
      return result;
    }

    let result = { lang: 'unknown', isUnknown: true, confidence: 'low' };

    if (chromeResult.languages && chromeResult.languages.length > 0) {
      const topLang = chromeResult.languages.reduce((a, b) =>
        (a.percentage > b.percentage) ? a : b
      );

      const detectedLang = normalizeLanguageCode(topLang.language);
      const isValid = validateChromeResult(detectedLang, text);

      if (topLang.percentage >= 40 && isValid) {
        result = {
          lang: detectedLang,
          isUnknown: false,
          confidence: topLang.percentage >= 70 ? 'high' : 'medium'
        };
      }
    }

    langCache.set(cacheKey, result);
    return result;
  }

  function validateChromeResult(detectedLang, text) {
    const hangulMatches = text.match(HANGUL_REGEX) || [];
    const kanaMatches = text.match(HIRAGANA_REGEX) || [];
    const katakanaMatches = text.match(KATAKANA_REGEX) || [];

    const hangulCount = hangulMatches.length;
    const kanaCount = kanaMatches.length + katakanaMatches.length;

    if (detectedLang === 'ja') {
      if (hangulCount > 0 && kanaCount === 0) return false;
      if (kanaCount === 0) return false;
    }

    if (detectedLang === 'ko' && hangulCount === 0) {
      return false;
    }

    return true;
  }

  function normalizeLanguageCode(code) {
    if (code.includes('-')) {
      return code.split('-')[0].toLowerCase();
    }
    return code.toLowerCase();
  }

  // ===========================================
  // FILTERING LOGIC
  // ===========================================
  function shouldFilterComment(detection) {
    if (detection.isUnknown && !settings.hideUnknown) return false;
    if (detection.isUnknown && settings.hideUnknown) return true;
    if (detection.confidence === 'low' && !settings.hideUnknown) return false;
    return !settings.allowedLangs.includes(detection.lang);
  }

  // ===========================================
  // COMMENT PROCESSING
  // ===========================================
  function queueComments(comments, gen) {
    // Check if this generation is still current
    if (!isCurrentGeneration(gen)) return;

    const newComments = comments.filter(c => {
      if (c.hasAttribute(DATA_PROCESSED)) return false;
      if (c.classList.contains(CLASS_PROCESSED)) return false;
      if (pendingComments.includes(c)) return false;
      return true;
    });

    pendingComments.push(...newComments);

    if (processTimeout) {
      clearTimeout(processTimeout);
    }
    processTimeout = setTimeout(() => processQueue(gen), DEBOUNCE_MS);
  }

  async function processQueue(gen) {
    // Check if this generation is still current
    if (!isCurrentGeneration(gen)) {
      pendingComments = [];
      return;
    }

    if (isProcessing || pendingComments.length === 0) return;

    isProcessing = true;

    try {
      while (pendingComments.length > 0 && isCurrentGeneration(gen)) {
        const batch = pendingComments.splice(0, BATCH_SIZE);
        await processBatch(batch, gen);

        if (pendingComments.length > 0 && isCurrentGeneration(gen)) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
    } finally {
      isProcessing = false;
    }
  }

  async function processBatch(comments, gen) {
    const promises = comments.map(comment => processComment(comment, gen));
    await Promise.all(promises);
  }

  async function processComment(commentElement, gen) {
    // Check if still current generation
    if (!isCurrentGeneration(gen)) return;
    if (!settings.enabled) return;

    let renderer = commentElement;
    if (commentElement.tagName.toLowerCase() === 'ytd-comment-thread-renderer') {
      renderer = commentElement.querySelector('ytd-comment-renderer') || commentElement;
    }

    const textElement = renderer.querySelector('#content-text');
    if (!textElement) {
      markProcessed(commentElement);
      return;
    }

    const text = textElement.textContent?.trim();
    if (!text) {
      markProcessed(commentElement);
      return;
    }

    const detection = await detectLanguage(text, gen);

    // Check again after async operation
    if (!isCurrentGeneration(gen)) return;

    const shouldFilter = shouldFilterComment(detection);
    applyFilter(commentElement, renderer, shouldFilter, detection);
    markProcessed(commentElement);
  }

  function markProcessed(element) {
    element.classList.add(CLASS_PROCESSED);
    element.setAttribute(DATA_PROCESSED, '1');
  }

  // ===========================================
  // FILTER APPLICATION
  // ===========================================
  function applyFilter(commentElement, renderer, shouldFilter, detection) {
    resetFilter(commentElement, renderer);

    if (!shouldFilter) return;

    if (settings.mode === 'hide') {
      applyHideMode(commentElement);
    } else {
      applyCollapseMode(commentElement, renderer, detection);
    }
  }

  function resetFilter(commentElement, renderer) {
    commentElement.classList.remove(CLASS_HIDDEN);
    commentElement.classList.remove(CLASS_COLLAPSED);

    const placeholder = commentElement.querySelector('.' + CLASS_PLACEHOLDER);
    if (placeholder) placeholder.remove();

    const contentContainer = renderer.querySelector('#main, #body');
    if (contentContainer && originalContent.has(commentElement)) {
      contentContainer.style.display = '';
    }
  }

  function applyHideMode(commentElement) {
    commentElement.classList.add(CLASS_HIDDEN);
  }

  function applyCollapseMode(commentElement, renderer, detection) {
    commentElement.classList.add(CLASS_COLLAPSED);

    const contentContainer = renderer.querySelector('#main, #body');
    if (!contentContainer) return;

    if (!originalContent.has(commentElement)) {
      originalContent.set(commentElement, true);
    }

    contentContainer.style.display = 'none';

    const langDisplay = detection.isUnknown ? 'unknown' : detection.lang.toUpperCase();
    const placeholder = document.createElement('div');
    placeholder.className = CLASS_PLACEHOLDER;
    placeholder.innerHTML = `
      <span class="ylf-placeholder-text">Hidden (language: ${langDisplay})</span>
      <button class="ylf-show-btn">Show</button>
    `;

    const showBtn = placeholder.querySelector('.ylf-show-btn');
    showBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleCollapse(commentElement, contentContainer, placeholder, detection);
    });

    renderer.insertBefore(placeholder, renderer.firstChild);
  }

  function toggleCollapse(commentElement, contentContainer, placeholder, detection) {
    const isHidden = contentContainer.style.display === 'none';

    if (isHidden) {
      contentContainer.style.display = '';
      placeholder.querySelector('.ylf-placeholder-text').textContent = 'Shown';
      placeholder.querySelector('.ylf-show-btn').textContent = 'Hide';
      commentElement.classList.remove(CLASS_COLLAPSED);
      commentElement.classList.add('ylf-expanded');
    } else {
      contentContainer.style.display = 'none';
      const langDisplay = detection.isUnknown ? 'unknown' : detection.lang.toUpperCase();
      placeholder.querySelector('.ylf-placeholder-text').textContent = `Hidden (language: ${langDisplay})`;
      placeholder.querySelector('.ylf-show-btn').textContent = 'Show';
      commentElement.classList.add(CLASS_COLLAPSED);
      commentElement.classList.remove('ylf-expanded');
    }
  }

  // ===========================================
  // OBSERVER MANAGEMENT
  // ===========================================
  function observeComments(root, gen) {
    if (commentObserver) {
      commentObserver.disconnect();
      commentObserver = null;
    }

    if (!root) return;

    commentObserver = new MutationObserver((mutations) => {
      if (!settings.enabled) return;
      if (!isCurrentGeneration(gen)) return;

      const newComments = [];

      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (isCommentElement(node)) {
              newComments.push(node);
            }
            const comments = node.querySelectorAll?.(getCommentSelectors());
            if (comments) {
              newComments.push(...comments);
            }
          }
        }
      }

      if (newComments.length > 0) {
        queueComments(newComments, gen);
      }
    });

    commentObserver.observe(root, {
      childList: true,
      subtree: true
    });

    // Process existing comments
    const existingComments = root.querySelectorAll(getCommentSelectors());
    if (existingComments.length > 0) {
      queueComments([...existingComments], gen);
    }
  }

  function setupRootObserver(gen) {
    if (rootObserver) {
      rootObserver.disconnect();
      rootObserver = null;
    }

    const pageType = detectPageType();
    const root = findCommentsRoot(pageType);

    if (root) {
      observeComments(root, gen);
    }

    rootObserver = new MutationObserver(() => {
      if (!isCurrentGeneration(gen)) return;

      const currentRoot = findCommentsRoot(detectPageType());
      if (currentRoot && !commentObserver) {
        observeComments(currentRoot, gen);
      }
    });

    rootObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  function resetObservers() {
    if (commentObserver) {
      commentObserver.disconnect();
      commentObserver = null;
    }
    if (rootObserver) {
      rootObserver.disconnect();
      rootObserver = null;
    }
    if (processTimeout) {
      clearTimeout(processTimeout);
      processTimeout = null;
    }
    pendingComments = [];
    isProcessing = false;
  }

  // ===========================================
  // URL CHANGE DETECTION (SPA NAVIGATION)
  // ===========================================
  function setupUrlWatcher() {
    if (urlCheckInterval) {
      clearInterval(urlCheckInterval);
    }

    lastUrl = location.href;
    currentPageType = detectPageType();

    urlCheckInterval = setInterval(() => {
      const newUrl = location.href;

      if (newUrl !== lastUrl) {
        lastUrl = newUrl;
        const newPageType = detectPageType();

        // URL changed - invalidate old generation and start fresh
        if (newPageType) {
          setTimeout(() => {
            resetObservers();
            currentPageType = newPageType;
            const gen = newGeneration();
            setupRootObserver(gen);
          }, 500);
        } else {
          resetObservers();
          currentPageType = null;
        }
      }
    }, URL_CHECK_INTERVAL_MS);
  }

  // ===========================================
  // PROCESS ALL VISIBLE COMMENTS
  // ===========================================
  function processAllComments(gen) {
    if (!settings.enabled) return;
    if (!isCurrentGeneration(gen)) return;

    const pageType = detectPageType();
    if (!pageType) return;

    const comments = document.querySelectorAll(getCommentSelectors());
    queueComments([...comments], gen);
  }

  function reprocessAllComments() {
    // Start new generation to invalidate any pending async operations
    const gen = newGeneration();

    // Clear processed markers
    const processed = document.querySelectorAll('.' + CLASS_PROCESSED);
    processed.forEach(el => {
      el.classList.remove(CLASS_PROCESSED);
      el.removeAttribute(DATA_PROCESSED);

      const renderer = el.tagName.toLowerCase() === 'ytd-comment-thread-renderer'
        ? el.querySelector('ytd-comment-renderer') || el
        : el;
      resetFilter(el, renderer);
    });

    langCache.clear();
    processAllComments(gen);
  }

  // ===========================================
  // MESSAGE HANDLING
  // ===========================================
  function handleMessage(message, _sender, sendResponse) {
    // PING handler - confirms content script is alive
    if (message.type === 'PING') {
      sendResponse({
        ok: true,
        page: location.href,
        ts: Date.now()
      });
      return true;
    }

    if (message.type === 'SETTINGS_UPDATED') {
      settings = { ...DEFAULT_SETTINGS, ...message.settings };
      reprocessAllComments();
      sendResponse({ success: true });
      return true;
    }

    if (message.type === 'RESCAN') {
      reprocessAllComments();
      sendResponse({ success: true });
      return true;
    }

    return false;
  }

  // ===========================================
  // INITIALIZATION
  // ===========================================
  async function loadSettings() {
    if (!isRuntimeValid()) return;

    try {
      const result = await chrome.storage.local.get('settings');
      if (result.settings) {
        settings = { ...DEFAULT_SETTINGS, ...result.settings };
      }
    } catch (error) {
      // Context may be invalid - ignore
    }
  }

  async function init() {
    if (isInitialized) return;
    isInitialized = true;

    await loadSettings();

    // Set up message listener
    if (isRuntimeValid()) {
      chrome.runtime.onMessage.addListener(handleMessage);
    }

    // Set up URL watcher for SPA navigation
    setupUrlWatcher();

    // Set up observers for current page
    const pageType = detectPageType();
    if (pageType) {
      currentPageType = pageType;
      const gen = newGeneration();
      setupRootObserver(gen);
    }
  }

  // Start initialization when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
