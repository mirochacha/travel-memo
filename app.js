(() => {
  'use strict';

  const DB_NAME = 'tabi-memo-db';
  const DB_VERSION = 2;
  const STORE_NAME = 'notes';
  const FOLDERS_STORE = 'folders';
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const methodLabels = {
    speech: '🎙 音声入力',
    text: '✎ テキスト',
    audio: '◉ 音声メモ'
  };

  let db;
  let recognition;
  let isListening = false;
  let finalTranscript = '';
  let editingId = null;
  let detailId = null;
  let editorMethod = 'text';
  let mediaRecorder;
  let mediaStream;
  let audioChunks = [];
  let recordedBlob = null;
  let recordingStartedAt = 0;
  let timerId;
  let audioUrl;
  let detailAudioUrl;
  let activeFolderId = 'all';
  let currentFolderId = localStorage.getItem('tabi-memo-current-folder') || '';

  const $ = (selector) => document.querySelector(selector);
  const speechButton = $('#speech-button');
  const speechLabel = $('#speech-label');
  const speechStatus = $('#speech-status');
  const speechUnavailable = $('#speech-unavailable');
  const editorDialog = $('#editor-dialog');
  const editorForm = $('#editor-form');
  const noteText = $('#note-text');
  const retryButton = $('#retry-button');
  const detailDialog = $('#detail-dialog');
  const audioDialog = $('#audio-dialog');
  const confirmDialog = $('#confirm-dialog');
  const folderDialog = $('#folder-dialog');
  const toast = $('#toast');

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt');
        }
        if (!database.objectStoreNames.contains(FOLDERS_STORE)) {
          database.createObjectStore(FOLDERS_STORE, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function transact(mode, action, storeName = STORE_NAME) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      let result;
      try { result = action(store); } catch (error) { reject(error); return; }
      tx.oncomplete = () => resolve(result?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  const getAllNotes = () => transact('readonly', (store) => store.getAll());
  const getNote = (id) => transact('readonly', (store) => store.get(id));
  const putNote = (note) => transact('readwrite', (store) => store.put(note));
  const removeNote = (id) => transact('readwrite', (store) => store.delete(id));
  const getAllFolders = () => transact('readonly', (store) => store.getAll(), FOLDERS_STORE);
  const putFolder = (folder) => transact('readwrite', (store) => store.put(folder), FOLDERS_STORE);

  function escapeHtml(value = '') {
    return value.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
  }

  function localDateKey(dateValue) {
    const date = new Date(dateValue);
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  }

  function dateHeading(dateValue) {
    const date = new Date(dateValue);
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (localDateKey(date) === localDateKey(now)) return '今日のメモ';
    if (localDateKey(date) === localDateKey(yesterday)) return '昨日';
    return new Intl.DateTimeFormat('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' }).format(date);
  }

  function formatTime(dateValue) {
    return new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(dateValue));
  }

  function formatFullDate(dateValue) {
    return new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(dateValue));
  }

  function folderName(folderId, folders) {
    if (!folderId) return '未整理';
    return folders.find((folder) => folder.id === folderId)?.name || '未整理';
  }

  function folderOptions(folders, selectedId = '') {
    return [{ id: '', name: '未整理' }, ...folders]
      .map((folder) => `<option value="${folder.id}"${folder.id === selectedId ? ' selected' : ''}>${escapeHtml(folder.name)}</option>`)
      .join('');
  }

  function renderFolderControls(folders, allNotes) {
    if (currentFolderId && !folders.some((folder) => folder.id === currentFolderId)) currentFolderId = '';
    if (activeFolderId !== 'all' && activeFolderId && !folders.some((folder) => folder.id === activeFolderId)) activeFolderId = 'all';
    const tabs = [{ id: 'all', name: 'すべて' }, { id: '', name: '未整理' }, ...folders];
    $('#folder-tabs').innerHTML = tabs.map((folder) => {
      const count = folder.id === 'all' ? allNotes.length : allNotes.filter((note) => (note.folderId || '') === folder.id).length;
      return `<button class="folder-tab" type="button" role="tab" data-folder-filter="${folder.id}" aria-selected="${folder.id === activeFolderId}">${escapeHtml(folder.name)} <span>${count}</span></button>`;
    }).join('');
    $('#destination-name').textContent = folderName(currentFolderId, folders);
    $('#folder-picker-list').innerHTML = [{ id: '', name: '未整理' }, ...folders].map((folder) => {
      const count = allNotes.filter((note) => (note.folderId || '') === folder.id).length;
      return `<button class="folder-picker-button${folder.id === currentFolderId ? ' current' : ''}" type="button" data-pick-folder="${folder.id}"><strong>${escapeHtml(folder.name)}</strong><span>${count}件${folder.id === currentFolderId ? '・保存先' : ''}</span></button>`;
    }).join('');
    $('#download-folder-button').textContent = activeFolderId === 'all' ? '↓ 全件を書き出す' : '↓ このフォルダー';
  }

  async function renderNotes() {
    const [allNotesRaw, folders] = await Promise.all([getAllNotes(), getAllFolders()]);
    const allNotes = allNotesRaw.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    renderFolderControls(folders, allNotes);
    const notes = activeFolderId === 'all' ? allNotes : allNotes.filter((note) => (note.folderId || '') === activeFolderId);
    $('#note-count').textContent = `${notes.length}件`;
    $('#empty-state').hidden = notes.length > 0;
    const groups = new Map();
    notes.forEach((note) => {
      const key = localDateKey(note.createdAt);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(note);
    });
    $('#notes-list').innerHTML = [...groups.values()].map((group) => `
      <section class="day-group">
        <h3 class="day-heading">${dateHeading(group[0].createdAt)}</h3>
        ${group.map((note) => `
          <button class="note-card" type="button" data-note-id="${note.id}" aria-label="${formatTime(note.createdAt)}のメモを開く">
            <time class="note-time" datetime="${note.createdAt}">${formatTime(note.createdAt)}</time>
            <span class="note-main">
              <span class="note-body">${escapeHtml(note.body || '音声メモ')}</span>
              <span class="note-method">${methodLabels[note.inputMethod] || '旅メモ'}<span class="note-folder">${escapeHtml(folderName(note.folderId, folders))}</span></span>
            </span>
            <span class="note-arrow" aria-hidden="true">›</span>
          </button>`).join('')}
      </section>`).join('');
  }

  function showToast(message = '✓ 保存しました') {
    toast.textContent = message;
    toast.classList.add('show');
    window.setTimeout(() => toast.classList.remove('show'), 1800);
  }

  async function openEditor({ body = '', method = 'text', id = null, speech = false, folderId = currentFolderId } = {}) {
    editingId = id;
    editorMethod = method;
    noteText.value = body;
    const folders = await getAllFolders();
    $('#note-folder').innerHTML = folderOptions(folders, folderId || '');
    $('#editor-title').textContent = id ? '旅メモを編集' : speech ? '認識結果を確認' : '今感じたことを書こう';
    $('#editor-kicker').textContent = id ? 'EDIT NOTE' : speech ? 'SPEECH RESULT' : 'NEW NOTE';
    $('#recognition-hint').textContent = speech ? '施設名などを確認してください' : '';
    retryButton.hidden = !speech;
    updateCharCount();
    editorDialog.showModal();
    window.setTimeout(() => noteText.focus(), 80);
  }

  function closeEditor() {
    editorDialog.close();
    editingId = null;
    finalTranscript = '';
  }

  function updateCharCount() {
    $('#char-count').textContent = `${noteText.value.length} / 2000`;
  }

  async function saveTextNote() {
    const body = noteText.value.trim();
    if (!body) return;
    const now = new Date().toISOString();
    const folderId = $('#note-folder').value;
    if (editingId) {
      const current = await getNote(editingId);
      if (!current) return;
      await putNote({ ...current, body, folderId, updatedAt: now });
    } else {
      await putNote({ id: crypto.randomUUID(), body, folderId, inputMethod: editorMethod, createdAt: now, updatedAt: now });
    }
    closeEditor();
    await renderNotes();
    showToast();
  }

  function mergeRecognitionText(existing, incoming) {
    const base = existing.trim();
    const next = incoming.trim();
    if (!next) return base;
    if (!base) return next;
    if (base === next || base.endsWith(next) || base.includes(next)) return base;
    if (next.startsWith(base)) return next;
    const maxOverlap = Math.min(base.length, next.length);
    for (let length = maxOverlap; length > 0; length -= 1) {
      if (base.slice(-length) === next.slice(0, length)) return base + next.slice(length);
    }
    const needsSpace = /[A-Za-z0-9]$/.test(base) && /^[A-Za-z0-9]/.test(next);
    return `${base}${needsSpace ? ' ' : ''}${next}`;
  }

  function setupRecognition() {
    if (!SpeechRecognition) {
      speechUnavailable.hidden = false;
      speechButton.setAttribute('aria-label', '音声認識は非対応です。テキスト入力または音声録音を利用してください');
      speechStatus.textContent = 'このブラウザでは音声認識を利用できません';
      return;
    }
    recognition = new SpeechRecognition();
    recognition.lang = 'ja-JP';
    recognition.interimResults = true;
    recognition.continuous = false;

    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const text = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalTranscript = mergeRecognitionText(finalTranscript, text);
        else interim = mergeRecognitionText(interim, text);
      }
      speechStatus.textContent = mergeRecognitionText(finalTranscript, interim) || '聞いています…';
    };
    recognition.onerror = (event) => {
      if (event.error === 'aborted') return;
      speechStatus.textContent = event.error === 'not-allowed' ? 'マイクの許可が必要です' : 'うまく聞き取れませんでした。もう一度お試しください';
    };
    recognition.onend = () => {
      setListening(false);
      const transcript = finalTranscript.trim();
      if (transcript) openEditor({ body: transcript, method: 'speech', speech: true });
      else if (speechStatus.textContent === '聞いています…') speechStatus.textContent = '音声を認識できませんでした';
    };
  }

  function setListening(value) {
    isListening = value;
    speechButton.classList.toggle('listening', value);
    speechLabel.textContent = value ? '■ 停止' : '今の感想を話す';
    speechButton.querySelector('small').textContent = value ? 'タップして認識を終了' : 'タップして音声入力';
    if (value) speechStatus.textContent = '聞いています…';
  }

  function toggleRecognition() {
    if (!recognition) {
      speechUnavailable.hidden = false;
      $('#text-button').focus();
      return;
    }
    if (isListening) {
      recognition.stop();
      return;
    }
    finalTranscript = '';
    try {
      recognition.start();
      setListening(true);
    } catch (error) {
      speechStatus.textContent = '音声入力を開始できませんでした';
    }
  }

  async function showDetail(id) {
    const [note, folders] = await Promise.all([getNote(id), getAllFolders()]);
    if (!note) return;
    detailId = id;
    $('#detail-date').textContent = formatFullDate(note.createdAt);
    $('#detail-method').textContent = methodLabels[note.inputMethod] || note.inputMethod;
    $('#detail-folder').textContent = folderName(note.folderId, folders);
    $('#detail-text').textContent = note.body || '音声メモ';
    const audio = $('#detail-audio');
    if (detailAudioUrl) URL.revokeObjectURL(detailAudioUrl);
    if (note.audioBlob) {
      detailAudioUrl = URL.createObjectURL(note.audioBlob);
      audio.src = detailAudioUrl;
      audio.hidden = false;
    } else {
      audio.pause();
      audio.removeAttribute('src');
      audio.hidden = true;
    }
    detailDialog.showModal();
  }

  function releaseMedia() {
    if (timerId) window.clearInterval(timerId);
    timerId = null;
    mediaStream?.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }

  function resetRecorder() {
    releaseMedia();
    recordedBlob = null;
    audioChunks = [];
    $('#record-visual').classList.remove('recording');
    $('#record-status').textContent = '録音ボタンを押すと始まります';
    $('#record-timer').textContent = '00:00';
    $('#record-button').textContent = '● 録音する';
    $('#record-button').hidden = false;
    $('#save-audio-button').hidden = true;
    const preview = $('#record-preview');
    preview.pause();
    preview.hidden = true;
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = null;
  }

  function updateTimer() {
    const seconds = Math.floor((Date.now() - recordingStartedAt) / 1000);
    const mins = String(Math.floor(seconds / 60)).padStart(2, '0');
    const secs = String(seconds % 60).padStart(2, '0');
    $('#record-timer').textContent = `${mins}:${secs}`;
  }

  async function toggleRecording() {
    if (mediaRecorder?.state === 'recording') {
      mediaRecorder.stop();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      $('#record-status').textContent = 'このブラウザでは音声録音を利用できません';
      return;
    }
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunks = [];
      mediaRecorder = new MediaRecorder(mediaStream);
      mediaRecorder.ondataavailable = (event) => { if (event.data.size) audioChunks.push(event.data); };
      mediaRecorder.onstop = () => {
        recordedBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
        releaseMedia();
        $('#record-visual').classList.remove('recording');
        $('#record-status').textContent = '録音できました。再生して確認できます';
        $('#record-button').hidden = true;
        $('#save-audio-button').hidden = false;
        audioUrl = URL.createObjectURL(recordedBlob);
        $('#record-preview').src = audioUrl;
        $('#record-preview').hidden = false;
      };
      mediaRecorder.start();
      recordingStartedAt = Date.now();
      updateTimer();
      timerId = window.setInterval(updateTimer, 500);
      $('#record-visual').classList.add('recording');
      $('#record-status').textContent = '録音しています…';
      $('#record-button').textContent = '■ 停止';
    } catch (error) {
      releaseMedia();
      $('#record-status').textContent = error?.name === 'NotAllowedError' ? 'マイクの許可が必要です' : '録音を開始できませんでした';
    }
  }

  async function saveAudioNote() {
    if (!recordedBlob) return;
    const now = new Date().toISOString();
    await putNote({ id: crypto.randomUUID(), body: '音声メモ', folderId: $('#audio-folder').value, inputMethod: 'audio', createdAt: now, updatedAt: now, audioBlob: recordedBlob });
    audioDialog.close();
    resetRecorder();
    await renderNotes();
    showToast('✓ 音声を保存しました');
  }

  async function openFolderDialog() {
    await renderNotes();
    folderDialog.showModal();
  }

  async function createFolder(name) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const folders = await getAllFolders();
    const existing = folders.find((folder) => folder.name.toLocaleLowerCase('ja') === trimmed.toLocaleLowerCase('ja'));
    const folder = existing || { id: crypto.randomUUID(), name: trimmed, createdAt: new Date().toISOString() };
    if (!existing) await putFolder(folder);
    currentFolderId = folder.id;
    activeFolderId = folder.id;
    localStorage.setItem('tabi-memo-current-folder', currentFolderId);
    $('#folder-name').value = '';
    await renderNotes();
    folderDialog.close();
    showToast(existing ? '保存先を選びました' : '✓ フォルダーを作成しました');
  }

  async function prepareAudioDialog() {
    resetRecorder();
    $('#audio-folder').innerHTML = folderOptions(await getAllFolders(), currentFolderId);
    audioDialog.showModal();
  }

  function safeFileName(value) {
    return value.replace(/[\\/:*?"<>|]/g, '＿').trim() || '旅メモ';
  }

  async function downloadActiveFolder() {
    const [folders, allNotes] = await Promise.all([getAllFolders(), getAllNotes()]);
    const notes = (activeFolderId === 'all' ? allNotes : allNotes.filter((note) => (note.folderId || '') === activeFolderId))
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const title = activeFolderId === 'all' ? '旅メモ・すべて' : folderName(activeFolderId, folders);
    const lines = [`${title}`, `書き出し日時: ${formatFullDate(new Date().toISOString())}`, '', ...notes.flatMap((note) => [
      `--- ${formatFullDate(note.createdAt)} / ${methodLabels[note.inputMethod]?.replace(/^[^ ]+ /, '') || '旅メモ'} ---`,
      note.body || '音声メモ（音声データはアプリ内で再生できます）',
      ''
    ])];
    const blob = new Blob(['\uFEFF', lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${safeFileName(title)}.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`↓ ${notes.length}件を書き出しました`);
  }

  async function registerWebMcpTools() {
    if (!document.modelContext?.registerTool) return;
    const register = (tool) => Promise.resolve(document.modelContext.registerTool(tool)).catch(() => {});
    await register({
      name: 'list_travel_notes',
      title: '旅メモを一覧表示',
      description: 'この端末に保存されている旅メモを新しい順に返します。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: async () => (await getAllNotes()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).map(({ id, body, inputMethod, createdAt, updatedAt }) => ({ id, body, inputMethod, createdAt, updatedAt }))
    });
    await register({
      name: 'create_text_travel_note',
      title: 'テキスト旅メモを保存',
      description: '本文を端末内の旅メモとして保存し、画面の一覧も更新します。',
      inputSchema: { type: 'object', properties: { body: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['body'], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: async (input) => {
        const body = typeof input?.body === 'string' ? input.body.trim() : '';
        if (!body || body.length > 2000) throw new Error('本文は1〜2000文字で入力してください。');
        const now = new Date().toISOString();
        const note = { id: crypto.randomUUID(), body, folderId: currentFolderId, inputMethod: 'text', createdAt: now, updatedAt: now };
        await putNote(note);
        await renderNotes();
        showToast();
        return { id: note.id, saved: true };
      }
    });
  }

  speechButton.addEventListener('click', toggleRecognition);
  $('#text-button').addEventListener('click', () => openEditor());
  $('#audio-button').addEventListener('click', () => prepareAudioDialog().catch(handleError));
  $('#destination-button').addEventListener('click', () => openFolderDialog().catch(handleError));
  $('#new-folder-button').addEventListener('click', () => openFolderDialog().catch(handleError));
  $('#download-folder-button').addEventListener('click', () => downloadActiveFolder().catch(handleError));
  $('#folder-tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('[data-folder-filter]');
    if (!tab) return;
    activeFolderId = tab.dataset.folderFilter;
    renderNotes().catch(handleError);
  });
  $('#folder-picker-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-pick-folder]');
    if (!button) return;
    currentFolderId = button.dataset.pickFolder;
    activeFolderId = currentFolderId;
    localStorage.setItem('tabi-memo-current-folder', currentFolderId);
    folderDialog.close();
    renderNotes().then(() => showToast('保存先を選びました')).catch(handleError);
  });
  $('#folder-form').addEventListener('submit', (event) => {
    event.preventDefault();
    createFolder($('#folder-name').value).catch(handleError);
  });
  noteText.addEventListener('input', updateCharCount);
  editorForm.addEventListener('submit', (event) => { event.preventDefault(); saveTextNote().catch(handleError); });
  retryButton.addEventListener('click', () => { closeEditor(); window.setTimeout(toggleRecognition, 100); });
  $('#notes-list').addEventListener('click', (event) => {
    const card = event.target.closest('[data-note-id]');
    if (card) showDetail(card.dataset.noteId).catch(handleError);
  });
  $('#edit-button').addEventListener('click', async () => {
    const note = await getNote(detailId);
    detailDialog.close();
    openEditor({ body: note.body || '', method: note.inputMethod, id: note.id, folderId: note.folderId || '' });
  });
  $('#delete-button').addEventListener('click', () => confirmDialog.showModal());
  $('#cancel-delete').addEventListener('click', () => confirmDialog.close());
  $('#confirm-delete').addEventListener('click', async () => {
    await removeNote(detailId);
    confirmDialog.close();
    detailDialog.close();
    await renderNotes();
    showToast('削除しました');
  });
  $('#record-button').addEventListener('click', () => toggleRecording().catch(handleError));
  $('#save-audio-button').addEventListener('click', () => saveAudioNote().catch(handleError));
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-close]');
    if (!target) return;
    const dialog = document.getElementById(target.dataset.close);
    if (dialog === audioDialog && mediaRecorder?.state === 'recording') mediaRecorder.stop();
    dialog.close();
    if (dialog === audioDialog) resetRecorder();
  });
  [editorDialog, detailDialog, audioDialog, folderDialog].forEach((dialog) => {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) {
        if (dialog === audioDialog && mediaRecorder?.state === 'recording') mediaRecorder.stop();
        dialog.close();
        if (dialog === audioDialog) resetRecorder();
      }
    });
  });
  audioDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    if (mediaRecorder?.state === 'recording') mediaRecorder.stop();
    audioDialog.close();
    resetRecorder();
  });

  function handleError(error) {
    console.error(error);
    showToast('保存できませんでした');
  }

  async function init() {
    try {
      db = await openDatabase();
      setupRecognition();
      await renderNotes();
      await registerWebMcpTools();
      if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(console.error);
    } catch (error) {
      console.error(error);
      speechStatus.textContent = '端末内ストレージを利用できません';
    }
  }

  init();
})();
