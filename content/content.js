// YouTube Language Filter - Content Script
// Supports both Watch pages and Shorts pages with hybrid language detection
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
  // Language detection cache: Map<string, { lang: string, isUnknown: boolean, confidence: string }>
  const langCache = new Map();

  // WeakMap to store original content for collapsed comments
  const originalContent = new WeakMap();

  // Processing state
  let isProcessing = false;
  let pendingComments = [];
  let processTimeout = null;
  let observer = null;
  let urlObserver = null;

  // ===========================================
  // CONSTANTS
  // ===========================================
  const DEBOUNCE_MS = 200;
  const BATCH_SIZE = 20;
  const SAMPLE_LENGTH = 200;

  // CSS classes
  const CLASS_HIDDEN = 'ylf-hidden';
  const CLASS_COLLAPSED = 'ylf-collapsed';
  const CLASS_PLACEHOLDER = 'ylf-placeholder';
  const CLASS_PROCESSED = 'ylf-processed';

  // Data attribute for processed marker (more reliable than class)
  const DATA_PROCESSED = 'data-ylf-processed';

  // ===========================================
  // UNICODE RANGES FOR SCRIPT DETECTION
  // ===========================================
  // Hangul (Korean)
  // - Syllables: AC00-D7A3 (가-힣)
  // - Jamo: 1100-11FF
  // - Compatibility Jamo: 3130-318F (ㄱ-ㅎ, ㅏ-ㅣ) - includes ㅋ, ㅎ, etc.
  const HANGUL_REGEX = /[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]/g;

  // Japanese Hiragana: 3040-309F (あ-ん)
  const HIRAGANA_REGEX = /[\u3040-\u309F]/g;

  // Japanese Katakana: 30A0-30FF (ア-ン) + 31F0-31FF (extended)
  const KATAKANA_REGEX = /[\u30A0-\u30FF\u31F0-\u31FF]/g;

  // CJK Han ideographs (shared by Chinese, Japanese, Korean)
  const HAN_REGEX = /[\u4E00-\u9FFF]/g;

  // Latin letters
  const LATIN_REGEX = /[A-Za-z]/g;

  // URL pattern for removal
  const URL_REGEX = /https?:\/\/[^\s]+/g;

  // ===========================================
  // PAGE TYPE DETECTION
  // ===========================================
  function getPageType() {
    const path = window.location.pathname;
    if (path.startsWith('/watch')) return 'watch';
    if (path.startsWith('/shorts')) return 'shorts';
    return null;
  }

  function isValidPage() {
    return getPageType() !== null;
  }

  // ===========================================
  // SCRIPT-BASED HEURISTIC LANGUAGE CLASSIFIER
  // ===========================================
  /**
   * Analyzes text using Unicode script ranges to determine language.
   * This is fast, deterministic, and prevents misclassification of Korean as Japanese.
   *
   * Key rules to prevent reported bugs:
   * 1. If Hangul exists (including ㅋㅋㅋ), NEVER classify as Japanese
   * 2. If no kana exists, NEVER classify as Japanese
   * 3. Latin-dominant text with no Asian scripts → English/Latin
   *
   * @param {string} text - The comment text to analyze
   * @returns {{ lang: string, confidence: string }} - detected language and confidence level
   */
  function heuristicDetect(text) {
    // Normalize: remove URLs and collapse whitespace
    let normalized = text.replace(URL_REGEX, '').trim();

    // Count characters by script
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

    // Total meaningful characters (excluding spaces, punctuation, emoji)
    const totalScriptChars = hangulCount + kanaCount + hanCount + latinCount;

    // If very few script characters, return uncertain
    if (totalScriptChars < 2) {
      return { lang: 'unknown', confidence: 'low' };
    }

    // Calculate ratios
    const hangulRatio = hangulCount / totalScriptChars;
    const kanaRatio = kanaCount / totalScriptChars;
    const hanRatio = hanCount / totalScriptChars;
    const latinRatio = latinCount / totalScriptChars;

    // ===========================================
    // DECISION RULES (order matters!)
    // ===========================================

    // RULE 1: Korean detection
    // If Hangul is present significantly, classify as Korean
    // This catches "한글댓글예시 ㅋㅋㅋㅋ" - the ㅋ characters are Hangul Jamo
    // Threshold: ratio >= 0.20 OR count >= 2 with Hangul dominating other Asian scripts
    if (hangulCount >= 2 && (hangulRatio >= 0.20 || hangulCount > kanaCount)) {
      return { lang: 'ko', confidence: 'high' };
    }
    if (hangulCount >= 1 && kanaCount === 0 && hanCount === 0) {
      // Any Hangul with no competing Asian scripts
      return { lang: 'ko', confidence: 'medium' };
    }

    // RULE 2: Japanese detection
    // CRITICAL: Only if kana exists AND no significant Hangul
    // This prevents misclassifying Korean as Japanese
    if (kanaCount >= 2 && hangulCount === 0) {
      if (kanaRatio >= 0.10) {
        return { lang: 'ja', confidence: 'high' };
      }
    }
    // Kana present but Hangul also present → uncertain (could be mixed)
    if (kanaCount >= 1 && hangulCount >= 1) {
      return { lang: 'uncertain', confidence: 'low' };
    }

    // RULE 3: Chinese detection (Han-only, no kana, no hangul)
    // When Han characters dominate without Japanese kana or Korean hangul
    if (hanCount >= 2 && hangulCount === 0 && kanaCount === 0) {
      if (hanRatio >= 0.30 || (hanRatio >= 0.20 && latinRatio < 0.50)) {
        return { lang: 'zh', confidence: 'medium' };
      }
    }

    // RULE 4: English/Latin detection
    // Latin dominates with minimal Asian scripts
    // This catches "wow, 400$, cheaper than an actual girlfriend face-purple-cryingno shot"
    if (latinRatio >= 0.30 && hangulCount === 0 && kanaCount === 0 && hanCount === 0) {
      return { lang: 'en', confidence: 'high' };
    }
    if (latinRatio >= 0.50 && (hangulCount + kanaCount + hanCount) <= 1) {
      return { lang: 'en', confidence: 'medium' };
    }

    // RULE 5: Mixed Han + Latin (common in Chinese social media)
    if (hanCount >= 1 && latinCount >= 1 && hangulCount === 0 && kanaCount === 0) {
      if (hanRatio > latinRatio) {
        return { lang: 'zh', confidence: 'low' };
      }
      return { lang: 'uncertain', confidence: 'low' };
    }

    // RULE 6: Uncertain - no clear dominant script
    return { lang: 'uncertain', confidence: 'low' };
  }

  // ===========================================
  // HYBRID LANGUAGE DETECTION
  // ===========================================
  /**
   * Hybrid detection: heuristic first, then chrome.i18n.detectLanguage as fallback.
   *
   * @param {string} text - The comment text
   * @returns {Promise<{ lang: string, isUnknown: boolean, confidence: string }>}
   */
  async function detectLanguage(text) {
    // Check cache first
    const cacheKey = text.substring(0, 100);
    if (langCache.has(cacheKey)) {
      return langCache.get(cacheKey);
    }

    // Step 1: Try heuristic detection
    const heuristic = heuristicDetect(text);

    // If heuristic is confident, use it directly
    if (heuristic.lang !== 'uncertain' && heuristic.lang !== 'unknown') {
      const result = {
        lang: heuristic.lang,
        isUnknown: false,
        confidence: heuristic.confidence
      };
      langCache.set(cacheKey, result);
      return result;
    }

    // If heuristic returned unknown (too short/symbols only)
    if (heuristic.lang === 'unknown') {
      const result = {
        lang: 'unknown',
        isUnknown: true,
        confidence: 'low'
      };
      langCache.set(cacheKey, result);
      return result;
    }

    // Step 2: Fallback to chrome.i18n.detectLanguage for uncertain cases
    const sample = text.substring(0, SAMPLE_LENGTH);

    try {
      const chromeResult = await new Promise((resolve) => {
        chrome.i18n.detectLanguage(sample, resolve);
      });

      let result = { lang: 'unknown', isUnknown: true, confidence: 'low' };

      if (chromeResult?.languages?.length > 0) {
        // Get top language by percentage
        const topLang = chromeResult.languages.reduce((a, b) =>
          (a.percentage > b.percentage) ? a : b
        );

        const detectedLang = normalizeLanguageCode(topLang.language);

        // Validate chrome result against script heuristics to prevent contradictions
        // This is the key fix: don't trust chrome if it contradicts script evidence
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
    } catch (error) {
      console.error('[YLF] Language detection failed:', error);
      const result = { lang: 'unknown', isUnknown: true, confidence: 'low' };
      langCache.set(cacheKey, result);
      return result;
    }
  }

  /**
   * Validates chrome.i18n result against script evidence.
   * Prevents chrome from returning 'ja' when there's Hangul or no kana.
   */
  function validateChromeResult(detectedLang, text) {
    const hangulMatches = text.match(HANGUL_REGEX) || [];
    const kanaMatches = text.match(HIRAGANA_REGEX) || [];
    const katakanaMatches = text.match(KATAKANA_REGEX) || [];

    const hangulCount = hangulMatches.length;
    const kanaCount = kanaMatches.length + katakanaMatches.length;

    // If chrome says Japanese, but there's Hangul and no kana → reject
    if (detectedLang === 'ja') {
      if (hangulCount > 0 && kanaCount === 0) {
        return false; // Hangul present, no kana → not Japanese
      }
      if (kanaCount === 0) {
        return false; // No kana at all → can't be confident it's Japanese
      }
    }

    // If chrome says Korean, but there's no Hangul → reject
    if (detectedLang === 'ko' && hangulCount === 0) {
      return false;
    }

    return true;
  }

  function normalizeLanguageCode(code) {
    // Handle variants like zh-CN, zh-TW -> zh
    if (code.includes('-')) {
      return code.split('-')[0].toLowerCase();
    }
    return code.toLowerCase();
  }

  // ===========================================
  // FILTERING LOGIC
  // ===========================================
  function shouldFilterComment(detection) {
    // If unknown and hideUnknown is false, don't filter
    if (detection.isUnknown && !settings.hideUnknown) {
      return false;
    }

    // If unknown and hideUnknown is true, filter
    if (detection.isUnknown && settings.hideUnknown) {
      return true;
    }

    // Low confidence detections are treated as unknown unless hideUnknown
    // This reduces false positives
    if (detection.confidence === 'low' && !settings.hideUnknown) {
      return false;
    }

    // Check if language is in allowed list
    return !settings.allowedLangs.includes(detection.lang);
  }

  // ===========================================
  // COMMENT NODE DISCOVERY
  // ===========================================
  /**
   * Gets the appropriate comment container selectors based on page type.
   * Shorts and Watch pages have different DOM structures.
   */
  function getCommentContainerSelectors() {
    const pageType = getPageType();

    if (pageType === 'shorts') {
      // Shorts comments are in a different container
      return [
        'ytd-comments#comments',
        'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-comments-section"]',
        '#comments.ytd-shorts',
        'ytd-reel-video-renderer #comments'
      ];
    }

    // Watch page selectors
    return [
      '#comments',
      'ytd-comments',
      '#content.ytd-comments'
    ];
  }

  /**
   * Gets comment element selectors (same for both page types).
   */
  function getCommentSelectors() {
    return 'ytd-comment-thread-renderer, ytd-comment-renderer';
  }

  function isCommentElement(element) {
    const tagName = element.tagName?.toLowerCase();
    return tagName === 'ytd-comment-thread-renderer' || tagName === 'ytd-comment-renderer';
  }

  // ===========================================
  // MUTATION OBSERVER SETUP
  // ===========================================
  function setupObserver() {
    if (observer) {
      observer.disconnect();
    }

    const containerSelectors = getCommentContainerSelectors();
    const containers = containerSelectors
      .map(sel => document.querySelector(sel))
      .filter(Boolean);

    if (containers.length === 0) {
      // Comments not loaded yet, retry later
      setTimeout(setupObserver, 1000);
      return;
    }

    observer = new MutationObserver((mutations) => {
      if (!settings.enabled) return;

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
        queueComments(newComments);
      }
    });

    containers.forEach(container => {
      observer.observe(container, {
        childList: true,
        subtree: true
      });
    });
  }

  // ===========================================
  // URL CHANGE DETECTION (SPA NAVIGATION)
  // ===========================================
  function setupUrlObserver() {
    if (urlObserver) {
      urlObserver.disconnect();
    }

    let lastUrl = location.href;
    let lastPageType = getPageType();

    urlObserver = new MutationObserver(() => {
      const currentUrl = location.href;
      if (currentUrl !== lastUrl) {
        lastUrl = currentUrl;
        const currentPageType = getPageType();

        if (currentPageType !== lastPageType) {
          lastPageType = currentPageType;
          // Page type changed, full reinitialize
          if (currentPageType) {
            setTimeout(() => {
              setupObserver();
              reprocessAllComments();
            }, 1000);
          }
        } else if (currentPageType) {
          // Same page type but different video, reinitialize
          setTimeout(() => {
            setupObserver();
            reprocessAllComments();
          }, 1000);
        }
      }
    });

    urlObserver.observe(document, { subtree: true, childList: true });
  }

  // ===========================================
  // COMMENT PROCESSING
  // ===========================================
  function queueComments(comments) {
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
    processTimeout = setTimeout(processQueue, DEBOUNCE_MS);
  }

  async function processQueue() {
    if (isProcessing || pendingComments.length === 0) return;

    isProcessing = true;

    try {
      while (pendingComments.length > 0) {
        const batch = pendingComments.splice(0, BATCH_SIZE);
        await processBatch(batch);

        if (pendingComments.length > 0) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
    } finally {
      isProcessing = false;
    }
  }

  async function processBatch(comments) {
    const promises = comments.map(comment => processComment(comment));
    await Promise.all(promises);
  }

  async function processComment(commentElement) {
    if (!settings.enabled) return;

    // Get the actual comment renderer
    let renderer = commentElement;
    if (commentElement.tagName.toLowerCase() === 'ytd-comment-thread-renderer') {
      renderer = commentElement.querySelector('ytd-comment-renderer') || commentElement;
    }

    // Get comment text
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

    // Detect language using hybrid approach
    const detection = await detectLanguage(text);

    // Determine if should be filtered
    const shouldFilter = shouldFilterComment(detection);

    // Apply filter
    applyFilter(commentElement, renderer, shouldFilter, detection);

    // Mark as processed
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

    if (!shouldFilter) {
      return;
    }

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
    if (placeholder) {
      placeholder.remove();
    }

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
      toggleCollapse(commentElement, renderer, contentContainer, placeholder, detection);
    });

    renderer.insertBefore(placeholder, renderer.firstChild);
  }

  function toggleCollapse(commentElement, renderer, contentContainer, placeholder, detection) {
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
  // PROCESS ALL COMMENTS
  // ===========================================
  function processAllComments() {
    if (!settings.enabled || !isValidPage()) return;

    const comments = document.querySelectorAll(getCommentSelectors());
    queueComments([...comments]);
  }

  function reprocessAllComments() {
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

    // Clear cache
    langCache.clear();

    // Reprocess
    processAllComments();
  }

  // ===========================================
  // MESSAGE HANDLING
  // ===========================================
  function handleMessage(message, sender, sendResponse) {
    if (message.type === 'SETTINGS_UPDATED') {
      settings = { ...DEFAULT_SETTINGS, ...message.settings };
      reprocessAllComments();
      sendResponse({ success: true });
    } else if (message.type === 'RESCAN') {
      reprocessAllComments();
      sendResponse({ success: true });
    }
    return true;
  }

  // ===========================================
  // INITIALIZATION
  // ===========================================
  async function loadSettings() {
    try {
      const result = await chrome.storage.local.get('settings');
      if (result.settings) {
        settings = { ...DEFAULT_SETTINGS, ...result.settings };
      }
    } catch (error) {
      console.error('[YLF] Failed to load settings:', error);
    }
  }

  async function init() {
    if (!isValidPage()) {
      // Still set up URL observer to detect navigation to valid pages
      setupUrlObserver();
      return;
    }

    await loadSettings();
    chrome.runtime.onMessage.addListener(handleMessage);
    setupObserver();
    setupUrlObserver();
    processAllComments();
  }

  // Start initialization
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
