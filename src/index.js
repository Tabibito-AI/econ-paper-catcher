// ソート関数の定義
const sorters = {
  registration: (a, b) => {
    const dateA = new Date(a.dataset.date.replace('年', '-').replace('月', '-').replace('日', ''));
    const dateB = new Date(b.dataset.date.replace('年', '-').replace('月', '-').replace('日', ''));
    return dateB - dateA;
  },
  acquisition: (a, b) => {
    const indexA = parseInt(a.dataset.index, 10);
    const indexB = parseInt(b.dataset.index, 10);
    return indexA - indexB;
  },
  journal: (a, b) => a.dataset.journal.localeCompare(b.dataset.journal),
  publication: (a, b) => {
    const dateA = new Date(a.dataset.publicationDate || a.dataset.date);
    const dateB = new Date(b.dataset.publicationDate || b.dataset.date);
    return dateB - dateA;
  }
};

// フィルター関数の定義
const filters = {
  category: (paper, category) => {
    if (!category || category === 'all') return true;
    return paper.dataset.category === category;
  }
};

// アプリケーションの状態管理
const appState = {
  currentSortType: 'registration',
  currentCategory: '教育・労働経済学',
  isArchive: false
};

// ソート機能の初期化
function initSorting() {
  const sortButtons = document.querySelectorAll('.sort-btn');
  const papersGrid = document.querySelector('.papers-grid');
  
  // 各ボタンにイベントリスナーを追加
  sortButtons.forEach(button => {
    button.addEventListener('click', (e) => {
      e.preventDefault(); // リンクのデフォルト動作を防止
      
      // アクティブ状態の更新
      sortButtons.forEach(btn => btn.classList.remove('active'));
      button.classList.add('active');
      
      // ソートタイプの取得と状態更新
      const sortType = button.dataset.sortType;
      appState.currentSortType = sortType;
      
      // アーカイブ状態の更新
      appState.isArchive = sortType === 'archive';
      
      // 論文の再表示
      updatePapersDisplay();
    });
  });
}

// フィルター機能の初期化
function initFiltering() {
  const filterButtons = document.querySelectorAll('.filter-btn');
  
  // 各ボタンにイベントリスナーを追加
  filterButtons.forEach(button => {
    button.addEventListener('click', () => {
      // アクティブ状態の更新
      filterButtons.forEach(btn => btn.classList.remove('active'));
      button.classList.add('active');
      
      // カテゴリの取得と状態更新
      const category = button.textContent.trim();
      appState.currentCategory = category;
      
      // 論文の再表示
      updatePapersDisplay();
    });
  });
}

// 論文表示の更新
function updatePapersDisplay() {
  const papersGrid = document.querySelector('.papers-grid');
  const papers = Array.from(papersGrid.children);
  
  // フィルタリングとソートの適用
  const filteredPapers = papers.filter(paper => 
    filters.category(paper, appState.currentCategory)
  );
  
  // アーカイブモードの場合は全ての論文を表示
  const displayPapers = appState.isArchive ? papers : filteredPapers;
  
  // ソート実行
  const sortedPapers = displayPapers.sort(sorters[appState.currentSortType] || sorters.registration);
  
  // 一旦全ての論文を非表示
  papers.forEach(paper => {
    paper.style.display = 'none';
  });
  
  // ソート済みの論文を表示
  sortedPapers.forEach(paper => {
    paper.style.display = '';
    papersGrid.appendChild(paper);
  });
  
  // 日付ヘッダーの更新
  updateDateHeaders();
}

// 日付ヘッダーの更新
function updateDateHeaders() {
  const dateHeaders = document.querySelectorAll('.date-header');
  
  // 一旦全ての日付ヘッダーを非表示
  dateHeaders.forEach(header => {
    header.style.display = 'none';
  });
  
  // 表示されている論文の日付に対応するヘッダーのみ表示
  const visiblePapers = Array.from(document.querySelectorAll('.paper-card')).filter(
    paper => paper.style.display !== 'none'
  );
  
  const visibleDates = new Set();
  visiblePapers.forEach(paper => {
    const date = paper.dataset.date;
    if (date) visibleDates.add(date);
  });
  
  dateHeaders.forEach(header => {
    const headerDate = header.textContent.trim();
    if (Array.from(visibleDates).some(date => date.includes(headerDate))) {
      header.style.display = '';
    }
  });
}

// モーダル機能の初期化
function initModal() {
  const cards = document.querySelectorAll('.paper-card');
  const modalOverlay = document.querySelector('.modal-overlay');
  const modalContainer = document.querySelector('.modal-container');
  const closeBtn = document.querySelector('.close-btn');
  
  // 各カードにクリックイベントを追加
  cards.forEach(card => {
    card.addEventListener('click', () => {
      // モーダルコンテンツの設定
      const title = card.querySelector('.paper-title').textContent;
      const abstract = card.dataset.abstract;
      const authors = card.dataset.authors;
      const journal = card.dataset.journal;
      const url = card.dataset.url;
      const translatedTitle = card.dataset.translatedTitle;
      const translatedAbstract = card.dataset.translatedAbstract;
      
      // モーダルHTMLの構築
      const modalContent = document.querySelector('.modal-content');
      modalContent.innerHTML = `
        <h2>${title}</h2>
        ${translatedTitle ? `<h3>日本語タイトル: ${translatedTitle}</h3>` : ''}
        <p><strong>著者:</strong> ${authors}</p>
        <p><strong>ジャーナル:</strong> ${journal}</p>
        ${url ? `<p><a href="${url}" target="_blank">論文リンク</a></p>` : ''}
        <h3>Abstract</h3>
        <p>${abstract}</p>
        ${translatedAbstract ? `<h3>日本語要約</h3><p>${translatedAbstract}</p>` : ''}
      `;
      
      // モーダルを表示
      modalOverlay.classList.add('active');
      modalContainer.classList.add('active');
    });
  });
  
  // 閉じるボタンの設定
  closeBtn.addEventListener('click', () => {
    modalOverlay.classList.remove('active');
    modalContainer.classList.remove('active');
  });
  
  // オーバーレイクリックで閉じる
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) {
      modalOverlay.classList.remove('active');
      modalContainer.classList.remove('active');
    }
  });
}

// DOM読み込み完了後に初期化
document.addEventListener('DOMContentLoaded', () => {
  // ソートボタンにdata-sort-type属性を追加
  const sortButtons = document.querySelectorAll('.sort-btn');
  sortButtons.forEach(button => {
    const text = button.textContent.trim();
    if (text.includes('登録日付順')) {
      button.dataset.sortType = 'registration';
    } else if (text.includes('取得順')) {
      button.dataset.sortType = 'acquisition';
    } else if (text.includes('ジャーナル別')) {
      button.dataset.sortType = 'journal';
    } else if (text.includes('出版日別')) {
      button.dataset.sortType = 'publication';
    } else if (text.includes('アーカイブ')) {
      button.dataset.sortType = 'archive';
    }
  });
  
  // 各機能の初期化
  initSorting();
  initFiltering();
  initModal();
  
  // 初期表示の設定
  updatePapersDisplay();
});
