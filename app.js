(function () {
  const C = window.APP_CONFIG;
  const db = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY);
  const $ = (id) => document.getElementById(id);
  const DOW = ['일', '월', '화', '수', '목', '금', '토'];

  const state = { me: null, bookings: [], tab: 'in' };

  // ---------- 유틸 ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  const iso = (dt) => dt.toISOString().slice(0, 10);
  const addDays = (s, n) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
  const md = (s) => { const d = parse(s); return [d.getUTCMonth() + 1, d.getUTCDate()]; };
  const dow = (s) => DOW[parse(s).getUTCDay()];
  // 점심 교차 운영: 초중(cj)과 고전(jg)은 4교시 실제 시간이 달라 서로 겹쳐도 된다
  const GROUP_LABEL = { cj: '초중', jg: '고전' };
  const classGroup = (name) => (/^(초|중)/.test(name) ? 'cj' : 'jg');
  const rangeOf =(kind) => (kind === 'in' ? C.IN_RANGE : C.OUT_RANGE);

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { t.hidden = true; }, 3500);
  }

  // 연속 교시는 범위로 묶는다: [1,2,4] -> ['1~2','4']
  function runs(periods, sep) {
    const p = [...periods].sort((a, b) => a - b);
    const out = [];
    for (let i = 0; i < p.length;) {
      let j = i;
      while (j + 1 < p.length && p[j + 1] === p[j] + 1) j++;
      out.push(j > i ? `${p[i]}${sep}${p[j]}` : `${p[i]}`);
      i = j + 1;
    }
    return out;
  }
  const periodText = (periods, sep = '~') => runs(periods, sep).join('·') + '교시';

  const joinUnique = (arr) => [...new Set(arr.filter(Boolean))].join(', ');
  const classNames = (cls) => cls.map((c) => c.name).join(', ');
  const studentSum = (cls) => cls.reduce((s, c) => s + c.students, 0);

  // ---------- 세션 ----------
  function saveSession() { try { sessionStorage.setItem('kiosk-me', JSON.stringify(state.me)); } catch (e) { /* 무시 */ } }
  function loadSession() {
    try { const v = JSON.parse(sessionStorage.getItem('kiosk-me')); if (v && v.name && v.pin) return v; } catch (e) { /* 무시 */ }
    return null;
  }

  // ---------- 학급 추가 UI ----------
  function renderAdder(box, onChange) {
    const courses = Object.keys(C.COURSES);
    const opts = (n, unit) => Array.from({ length: n }, (_, i) => `<option value="${i + 1}">${i + 1}${unit}</option>`).join('');
    box.innerHTML = `
      <div class="adder">
        <select data-k="course" aria-label="과정">${courses.map((c) => `<option>${esc(c)}</option>`).join('')}</select>
        <select data-k="grade" aria-label="학년"></select>
        <select data-k="cls" aria-label="반">${opts(C.CLASSES_PER_GRADE, '반')}</select>
        <select data-k="students" aria-label="학생 수">${opts(C.MAX_STUDENTS, '명')}</select>
        <button type="button" data-k="add">학급 추가</button>
      </div>`;
    const q = (k) => box.querySelector(`[data-k="${k}"]`);
    const fillGrades = () => { q('grade').innerHTML = opts(C.COURSES[q('course').value], '학년'); };
    fillGrades();
    q('course').addEventListener('change', fillGrades);
    q('add').addEventListener('click', () => {
      const name = `${q('course').value}${q('grade').value}-${q('cls').value}`;
      const students = Number(q('students').value);
      const list = state.draftClasses();
      const found = list.find((c) => c.name === name);
      if (found) found.students = students; else list.push({ name, students });
      onChange(list);
    });
  }

  function renderChips(box, list, onRemove) {
    box.innerHTML = list.map((c, i) =>
      `<span class="chip">${esc(c.name)} ${c.students}명<button type="button" data-i="${i}" aria-label="${esc(c.name)} 제거">x</button></span>`).join('')
      || '<span class="muted">담긴 학급이 없습니다.</span>';
    box.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => onRemove(Number(b.dataset.i))));
  }

  // ---------- 입장 ----------
  let entryClasses = [];
  function initEntry() {
    state.draftClasses = () => entryClasses;
    renderAdder($('entryAdder'), initEntryChips);
    initEntryChips();
    $('entryForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = $('teacherName').value.trim();
      const pin = $('teacherPin').value;
      const err = $('entryError');
      if (!name) { err.textContent = '교사 이름을 입력하세요.'; err.hidden = false; return; }
      if (!/^[0-9]{4}$/.test(pin)) { err.textContent = '비밀번호는 숫자 4자리입니다.'; err.hidden = false; return; }
      err.hidden = true;
      state.me = { name, pin, classes: entryClasses.slice() };
      saveSession();
      enterApp();
    });
  }
  function initEntryChips() {
    renderChips($('entryChips'), entryClasses, (i) => { entryClasses.splice(i, 1); initEntryChips(); });
  }

  // ---------- 앱 ----------
  function enterApp() {
    $('entry').hidden = true;
    $('app').hidden = false;
    $('meName').textContent = `${state.me.name} 선생님`;
    state.draftClasses = () => state.me.classes;
    renderAdder($('topAdder'), () => { saveSession(); renderTopChips(); renderModalIfOpen(); });
    renderTopChips();
    setTab('in');
  }

  function renderTopChips() {
    renderChips($('topChips'), state.me.classes, (i) => { state.me.classes.splice(i, 1); saveSession(); renderTopChips(); renderModalIfOpen(); });
  }

  function setTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    load();
  }

  async function load() {
    const { data, error } = await db.from('bookings_public').select('*').order('date');
    const el = $('loadError');
    if (error) { el.textContent = '불러오지 못했어요. 잠시 후 다시 시도해 주세요.'; el.hidden = false; return; }
    el.hidden = true;
    state.bookings = data;
    render();
  }

  function render() {
    const isReport = state.tab === 'report';
    $('calendarView').hidden = isReport;
    $('reportView').hidden = !isReport;
    if (isReport) renderReport(); else renderCalendar();
    renderModalIfOpen();
  }

  // ---------- 달력 ----------
  const myIn = () => state.bookings.filter((b) => b.kind === 'in' && b.teacher === state.me.name);
  const firstInDate = () => { const l = myIn().map((b) => b.date).sort(); return l[0] || null; };

  function dateEnabled(kind, date) {
    const [a, b] = rangeOf(kind);
    if (date < a || date > b) return false;
    if (kind === 'out') { const f = firstInDate(); return !!f && date > f; }
    return true;
  }

  function renderCalendar() {
    const kind = state.tab;
    const gate = $('gate');
    const locked = kind === 'out' && !firstInDate();
    gate.hidden = !(locked || kind === 'out');
    if (locked) gate.textContent = '교내 실습을 먼저 신청하세요.';
    else if (kind === 'out') gate.textContent = `교외 실습은 내 첫 교내 실습일(${md(firstInDate()).join('.')}) 이후 날짜만 신청할 수 있어요. ${C.ITEM_NOTICE}`;
    if (locked) { $('calendar').innerHTML = ''; return; }

    const last = rangeOf(kind)[1];
    let html = '<div class="cal">' + ['월', '화', '수', '목', '금'].map((d) => `<div class="cal-head">${d}</div>`).join('');
    for (let start = C.CAL_START; start <= last; start = addDays(start, 7)) {
      for (let i = 0; i < 5; i++) {
        const date = addDays(start, i);
        const on = dateEnabled(kind, date);
        const items = state.bookings.filter((b) => b.kind === kind && b.date === date)
          .sort((x, y) => Math.min(...x.periods) - Math.min(...y.periods))
          .map((b) => {
            const mine = b.teacher === state.me.name;
            const place = kind === 'out' && b.place ? ' ' + b.place.slice(0, 2) : '';
            const text = `${b.teacher} ${[...b.periods].sort((p, q) => p - q).join('·')}${place}`;
            return `<span class="tag ${mine ? 'mine' : ''}">${esc(text)}</span>`;
          }).join('');
        const [m, d] = md(date);
        html += `<button type="button" class="cell ${on ? 'on' : 'off'}" data-date="${date}" ${on ? '' : 'disabled'}><span class="d">${m}.${d}</span>${on ? items : ''}</button>`;
      }
    }
    $('calendar').innerHTML = html + '</div>';
    $('calendar').querySelectorAll('.cell.on').forEach((c) => c.addEventListener('click', () => openModal(c.dataset.date)));
  }

  // ---------- 모달 ----------
  let modalDate = null;
  const modalState = { periods: new Set(), four: null, rainPeriods: new Set(), form: {} };

  function openModal(date) {
    modalDate = date;
    modalState.periods = new Set();
    modalState.four = null;
    modalState.rainPeriods = new Set();
    modalState.form = {};
    $('modal').hidden = false;
    renderModal();
  }
  function closeModal() { modalDate = null; $('modal').hidden = true; }
  function renderModalIfOpen() { if (modalDate) renderModal(); }

  function selectWithCustom(id, list, label, value) {
    const known = list.includes(value) ? value : (value ? '직접 입력' : list[0]);
    const custom = value && !list.includes(value) ? value : '';
    return `<label>${label}
      <select id="${id}">${list.map((o) => `<option ${o === known ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>
      <input id="${id}Custom" type="text" placeholder="직접 입력" value="${esc(custom)}" ${known === '직접 입력' ? '' : 'hidden'}>
    </label>`;
  }
  function readSelectCustom(id) {
    const v = $(id).value;
    return v === '직접 입력' ? $(id + 'Custom').value.trim() : v;
  }

  function captureForm() {
    const f = modalState.form;
    const get = (id) => $(id);
    if (get('fSubject')) f.subject = readSelectCustom('fSubject');
    if (get('fUnit')) f.unit = get('fUnit').value;
    if (get('fPlace')) f.place = readSelectCustom('fPlace');
    if (get('fAssistant')) f.assistant = get('fAssistant').value;
    if (get('fRainDate')) f.rainDate = get('fRainDate').value;
  }

  function renderModal() {
    const kind = state.tab;
    const date = modalDate;
    const f = modalState.form;
    const [m, d] = md(date);
    $('modalTitle').textContent = `${m}월 ${d}일 (${dow(date)}) ${kind === 'in' ? '교내 실습' : '지역사회 실습'} 신청`;

    const dayBookings = state.bookings.filter((b) => b.kind === kind && b.date === date);
    const mine = dayBookings.filter((b) => b.teacher === state.me.name);

    // 교시 목록
    let periodsHtml = '';
    for (let p = 1; p <= C.PERIODS; p++) {
      const using = dayBookings.filter((b) => b.periods.includes(p));
      if (kind === 'in' && p === C.SPLIT_PERIOD) {
        // 점심 교차 운영: 4교시는 고전/초중이 서로 다른 시간이라 따로 신청
        ['jg', 'cj'].forEach((g) => {
          const taken = using.find((b) => b.lunch === g);
          const mismatch = !taken && state.me.classes.length && !state.me.classes.some((c) => classGroup(c.name) === g);
          const off = !!taken || mismatch;
          periodsHtml += `<label class="period ${off ? 'locked' : ''}">
            <input type="checkbox" data-four="${g}" ${off ? 'disabled' : ''} ${modalState.four === g ? 'checked' : ''}>
            ${p}교시(${GROUP_LABEL[g]})
            ${taken ? `<span class="who">${esc(taken.teacher)} · ${esc(classNames(taken.classes))}</span>`
              : mismatch ? `<span class="who">${GROUP_LABEL[g]} 학급만 신청</span>` : ''}</label>`;
        });
      } else if (kind === 'in') {
        const taken = using[0];
        periodsHtml += `<label class="period ${taken ? 'locked' : ''}">
          <input type="checkbox" data-p="${p}" ${taken ? 'disabled' : ''} ${modalState.periods.has(p) ? 'checked' : ''}>
          ${p}교시
          ${taken ? `<span class="who">${esc(taken.teacher)} · ${esc(classNames(taken.classes))}</span>` : ''}</label>`;
      } else {
        const who = using.map((b) => `${b.teacher} · ${b.place || ''}`).join(', ');
        periodsHtml += `<label class="period">
          <input type="checkbox" data-p="${p}" ${modalState.periods.has(p) ? 'checked' : ''}>
          ${p}교시 ${who ? `<span class="who">${esc(who)}</span>` : ''}</label>`;
      }
    }

    let fields = '';
    if (kind === 'in') {
      fields = selectWithCustom('fSubject', C.SUBJECTS, '연계 교과', f.subject) +
        `<label>단원<input id="fUnit" type="text" value="${esc(f.unit || '')}"></label>`;
    } else {
      const rainOpts = Array.from({ length: C.PERIODS }, (_, i) => i + 1).map((p) =>
        `<label><input type="checkbox" data-rp="${p}" ${modalState.rainPeriods.has(p) ? 'checked' : ''}>${p}교시</label>`).join('');
      fields = `<p class="notice">${esc(C.ITEM_NOTICE)}</p>` +
        selectWithCustom('fPlace', C.PLACES, '실습 장소', f.place) +
        `<label>보조 인솔교사<input id="fAssistant" type="text" value="${esc(f.assistant || '')}"></label>
         <label>우천 시 대체일<input id="fRainDate" type="date" min="${C.OUT_RANGE[0]}" value="${esc(f.rainDate || '')}"></label>
         <div class="field-title">우천 시 대체 교시</div><div class="rain-periods">${rainOpts}</div>` +
        selectWithCustom('fSubject', C.SUBJECTS, '관련 교과', f.subject);
    }

    const names = state.me.classes.map((c) => c.name).join(', ');
    const mineHtml = mine.length ? `<div class="mylist"><div class="field-title">내 신청</div>${mine.map((b) =>
      `<div class="mylist-row"><span>${periodText(b.periods)} · ${esc(classNames(b.classes))}</span><button type="button" class="small" data-del="${b.id}">삭제</button></div>`).join('')}</div>` : '';

    $('modalBody').innerHTML = `
      <div class="field-title">교시 선택</div>
      <div class="periods">${periodsHtml}</div>
      ${fields}
      <p id="modalError" class="error" hidden></p>
      <button type="button" id="submitBtn" class="primary">${names ? esc(names) + ' 신청하기' : '신청하기'}</button>
      ${mineHtml}`;

    const body = $('modalBody');
    body.querySelectorAll('[data-p]').forEach((el) => el.addEventListener('change', () => {
      const p = Number(el.dataset.p);
      if (el.checked) modalState.periods.add(p); else modalState.periods.delete(p);
    }));
    body.querySelectorAll('[data-four]').forEach((el) => el.addEventListener('change', () => {
      captureForm();
      modalState.four = el.checked ? el.dataset.four : null;
      renderModal();
    }));
    body.querySelectorAll('[data-rp]').forEach((el) => el.addEventListener('change', () => {
      const p = Number(el.dataset.rp);
      if (el.checked) modalState.rainPeriods.add(p); else modalState.rainPeriods.delete(p);
    }));
    ['fSubject', 'fPlace'].forEach((id) => {
      const sel = $(id);
      if (sel) sel.addEventListener('change', () => { $(id + 'Custom').hidden = sel.value !== '직접 입력'; });
    });
    body.querySelectorAll('[data-del]').forEach((el) => el.addEventListener('click', () => removeBooking(el.dataset.del)));
    $('submitBtn').addEventListener('click', submitBooking);
  }

  function showModalError(msg) { const e = $('modalError'); e.textContent = msg; e.hidden = false; }

  async function submitBooking() {
    captureForm();
    const kind = state.tab;
    const f = modalState.form;
    if (!state.me.classes.length) return showModalError('학급을 먼저 추가하세요. (상단 학급 편집)');
    const four = kind === 'in' ? modalState.four : null;
    if (!modalState.periods.size && !four) return showModalError('교시를 하나 이상 선택하세요.');
    if (four && !state.me.classes.every((c) => classGroup(c.name) === four)) {
      return showModalError(`4교시(${GROUP_LABEL[four]})에는 ${GROUP_LABEL[four]} 학급만 신청할 수 있어요. 담긴 학급을 확인하세요.`);
    }
    if (kind === 'out') {
      if (!f.place) return showModalError('실습 장소를 입력하세요.');
      if (f.rainDate && f.rainDate < C.OUT_RANGE[0]) return showModalError('우천 시 대체일을 확인하세요.');
    }
    const payload = {
      kind,
      teacher: state.me.name,
      classes: state.me.classes,
      date: modalDate,
      periods: [...modalState.periods, ...(four ? [C.SPLIT_PERIOD] : [])].sort((a, b) => a - b),
      subject: f.subject || null
    };
    if (kind === 'in') { payload.unit = f.unit || null; if (four) payload.lunch = four; }
    else {
      payload.place = f.place;
      payload.assistant = (f.assistant || '').trim() || null;
      payload.rain_date = f.rainDate || '';
      if (modalState.rainPeriods.size) payload.rain_periods = [...modalState.rainPeriods].sort((a, b) => a - b);
    }
    $('submitBtn').disabled = true;
    const { error } = await db.rpc('add_booking', { p: payload, pin: state.me.pin });
    if (error) {
      $('submitBtn').disabled = false;
      if ((error.message || '').includes('PERIOD_TAKEN')) {
        toast('방금 다른 선생님이 신청한 교시예요. 달력을 새로 불러왔어요.');
        modalState.periods = new Set();
        modalState.four = null;
        await load();
        return;
      }
      return showModalError('저장하지 못했어요. 잠시 후 다시 시도해 주세요.');
    }
    toast('신청했어요.');
    closeModal();
    await load();
  }

  async function removeBooking(id) {
    if (!confirm('이 신청을 삭제할까요?')) return;
    let pin = state.me.pin;
    let { data, error } = await db.rpc('delete_booking', { bid: id, pin });
    if (!error && !data) {
      pin = prompt('비밀번호 4자리를 입력하세요.');
      if (!pin) return;
      ({ data, error } = await db.rpc('delete_booking', { bid: id, pin }));
    }
    if (error) return toast('삭제하지 못했어요. 잠시 후 다시 시도해 주세요.');
    if (!data) return toast('비밀번호가 맞지 않아요.');
    toast('삭제했어요.');
    await load();
  }

  // ---------- 현황 ----------
  function buildReport() {
    const ins = state.bookings.filter((b) => b.kind === 'in');
    const outs = state.bookings.filter((b) => b.kind === 'out');

    // 교내: 교사 1명 1행
    const byTeacher = new Map();
    ins.forEach((b) => { if (!byTeacher.has(b.teacher)) byTeacher.set(b.teacher, []); byTeacher.get(b.teacher).push(b); });
    const inRows = [...byTeacher.entries()].map(([teacher, list]) => {
      list.sort((a, b) => a.date.localeCompare(b.date) || Math.min(...a.periods) - Math.min(...b.periods));
      const cls = new Map();
      list.forEach((b) => b.classes.forEach((c) => cls.set(c.name, c)));
      const clsList = [...cls.values()];
      return {
        first: list[0].date,
        cells: [teacher, clsList.map((c) => c.name).join(', '), String(studentSum(clsList)),
          joinUnique(list.map((b) => b.subject)), joinUnique(list.map((b) => b.unit)),
          list.map((b) => {
            const [m, d] = md(b.date);
            const lunch = b.lunch ? `(${b.periods.length > 1 ? '4교시 ' : ''}${GROUP_LABEL[b.lunch]})` : '';
            return `${m}월 ${d}일 (${dow(b.date)}, ${periodText(b.periods)}${lunch})`;
          }).join(', ')]
      };
    }).sort((a, b) => a.first.localeCompare(b.first));

    // 교외: 신청 1건 1행
    const dateFmt = (date, periods) => { const [m, d] = md(date); return `${m}.${d}.${dow(date)}.${periodText(periods, '-')}`; };
    const outRows = [...outs].sort((a, b) => a.date.localeCompare(b.date) || Math.min(...a.periods) - Math.min(...b.periods))
      .map((b) => [b.teacher, b.assistant || '', classNames(b.classes), String(studentSum(b.classes)),
        b.place || '', dateFmt(b.date, b.periods),
        b.rain_date ? dateFmt(b.rain_date, b.rain_periods && b.rain_periods.length ? b.rain_periods : []).replace(/\.교시$/, '') : '',
        b.subject || '']);

    // 집계 (학급명 중복 제거)
    const uniq = (list) => { const m = new Map(); list.forEach((b) => b.classes.forEach((c) => { if (!m.has(c.name)) m.set(c.name, c.students); })); return m; };
    const inClasses = uniq(ins);
    const outClasses = uniq(outs);
    const sum = (m) => [...m.values()].reduce((s, v) => s + v, 0);
    const outTeachers = new Set(outs.map((b) => b.teacher));
    return {
      inRows, outRows,
      nClasses: inClasses.size, nStudents: sum(inClasses), outStudents: sum(outClasses),
      missing: [...byTeacher.keys()].filter((t) => !outTeachers.has(t))
    };
  }

  const IN_HEAD = ['구분', '교사명', '학급', '학생수', '연계 교과', '단원', '운영 날짜'];
  const OUT_HEAD = ['구분', '교사', '보조 인솔교사', '학급', '학생수', '실습장소', '운영 날짜, 시간', '우천 시', '관련 교과'];
  const won = (n) => n.toLocaleString('ko-KR') + '원';

  function tableHtml(head, rows) {
    return `<div class="table-wrap"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>` +
      (rows.length ? rows.map((r, i) => `<tr><td>${i + 1}</td>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')
        : `<tr><td colspan="${head.length}" class="muted">아직 신청이 없습니다.</td></tr>`) + '</tbody></table></div>';
  }

  function renderReport() {
    const r = buildReport();
    const inRows = r.inRows.map((x) => x.cells);
    $('reportView').innerHTML = `
      <h3>교내 실습 참가 학급 현황 <button type="button" class="small" id="copyIn">표 복사</button></h3>
      ${tableHtml(IN_HEAD, inRows)}
      <h3>지역사회 실습 참가 학급 현황 <button type="button" class="small" id="copyOut">표 복사</button></h3>
      ${tableHtml(OUT_HEAD, r.outRows)}
      <div class="summary">
        <p>대상: ( ${r.nClasses} )개 학급 ( ${r.nStudents} )명</p>
        <p>물품구입비: 학생당 ${C.COST_ITEM.toLocaleString('ko-KR')}원 × ${r.nStudents} = ${won(C.COST_ITEM * r.nStudents)}</p>
        <p>실습비: 학생당 ${C.COST_FIELD.toLocaleString('ko-KR')}원 × ${r.outStudents} = ${won(C.COST_FIELD * r.outStudents)}</p>
        <p>교외 미신청: ${r.missing.length ? esc(r.missing.join(', ')) : '없음'}</p>
      </div>`;
    const tsv = (head, rows) => [head, ...rows.map((x, i) => [String(i + 1), ...x])].map((x) => x.join('\t')).join('\n');
    $('copyIn').addEventListener('click', () => copyText(tsv(IN_HEAD, inRows)));
    $('copyOut').addEventListener('click', () => copyText(tsv(OUT_HEAD, r.outRows)));
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); }
    catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
    }
    toast('표를 복사했어요. 한글에 붙여넣으세요.');
  }

  // ---------- 시작 ----------
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $('modalClose').addEventListener('click', closeModal);
  $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });
  $('editClassesBtn').addEventListener('click', () => { $('topAdder').hidden = !$('topAdder').hidden; });
  $('homeBtn').addEventListener('click', () => { $('leaveModal').hidden = false; });
  $('leaveCancel').addEventListener('click', () => { $('leaveModal').hidden = true; });
  $('leaveModal').addEventListener('click', (e) => { if (e.target === $('leaveModal')) $('leaveModal').hidden = true; });
  $('leaveOk').addEventListener('click', () => {
    try { sessionStorage.removeItem('kiosk-me'); } catch (e) { /* 무시 */ }
    location.reload();
  });
  window.addEventListener('focus', () => { if (state.me) load(); });

  initEntry();
  const saved = loadSession();
  if (saved) { state.me = saved; entryClasses = saved.classes; enterApp(); }
})();
