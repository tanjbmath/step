
    // ==========================================
    // 1. FIREBASE CONFIGURATION & INITIALIZATION
    // ==========================================
    const firebaseConfig = {
      apiKey: String.fromCharCode(65,73,122,97,83,121,65,66,103,112,113,79,54,76,95,67,116,109,52,72,88,85,97,106,81,112,84,83,81,55,119,74,86,73,115,114,97,80,48),
      authDomain: "classwork1314.firebaseapp.com",
      databaseURL: "https://classwork1314-default-rtdb.asia-southeast1.firebasedatabase.app",
      projectId: "classwork1314",
      storageBucket: "classwork1314.firebasestorage.app",
      messagingSenderId: "1073751121093",
      appId: "1:1073751121093:web:3cd277765b0cd61cea24ac",
      measurementId: "G-P61WJLX7WF"
    };

    let db = null;
    let auth = null;
    let storage = null;
    let isFirebaseReady = false;
    let signedInUser = null;
    // Canonical student name stored once per authenticated account.
    let studentProfileName = '';
    let accountRole = 'student';
    let historyUnsubscribe = null;
    let assignedHistoryUnsubscribe = null;
    let teacherAssignmentsUnsubscribe = null;
    // Keep exactly one live preview listener per joined student in the active assignment.
    const studentPreviewUnsubscribers = new Map();
    const studentPreviewData = new Map();
    const studentPreviewVersions = new Map();
    let teacherStatsRefreshTimer = null;
    // Short-lived shared cache lets teacher stats and assignment cards reuse roster reads.
    const teacherRosterReadCache = new Map();
    const TEACHER_ROSTER_CACHE_MS = 5000;

    async function getTeacherRosterSnapshot(assignmentRef, collectionName) {
      const key = assignmentRef.id + ':' + collectionName;
      const now = Date.now();
      const cached = teacherRosterReadCache.get(key);
      if (cached && cached.expiresAt > now) return cached.promise;

      const promise = assignmentRef.collection(collectionName).get().catch(err => {
        if (teacherRosterReadCache.get(key)?.promise === promise) teacherRosterReadCache.delete(key);
        throw err;
      });
      teacherRosterReadCache.set(key, { promise, expiresAt: now + TEACHER_ROSTER_CACHE_MS });
      return promise;
    }

    function invalidateTeacherRosterCache(assignmentId) {
      for (const key of teacherRosterReadCache.keys()) {
        if (key.startsWith(assignmentId + ':')) teacherRosterReadCache.delete(key);
      }
    }
    let studentAssignedRecords = [];
    let studentSubmissionRecords = [];
    let currentAssignedStudents = [];
    let currentJoinedStudents = [];
    let currentSubmissionStatus = 'in-progress';
    let currentAssignedStudentKey = null;
    let unsubAssignedStudents = null;
    const googleProvider = new firebase.auth.GoogleAuthProvider();

    try {
      firebase.initializeApp(firebaseConfig);
      db = firebase.firestore();
      auth = firebase.auth();
      storage = firebase.storage();
      auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(err => console.warn("Auth persistence:", err));
      auth.onAuthStateChanged(async user => {
        signedInUser = user || null;
        if (user) {
          currentClassId = loadActiveClassId(user.uid);
          selectedClassId = currentClassId;
        }
        isFirebaseReady = true;
        const signedOut = document.getElementById('signedOutPanel');
        const signedIn = document.getElementById('signedInPanel');
        const studentBtn = document.getElementById('selectStudentBtn');
        if (user) {
          signedOut.classList.add('hidden');
          signedIn.classList.remove('hidden');
          document.getElementById('accountName').textContent = user.displayName || 'Student';
          document.getElementById('accountEmail').textContent = user.email || '';
          const photo = document.getElementById('accountPhoto');
          if (user.photoURL) { photo.src = user.photoURL; photo.classList.remove('hidden'); }
          else photo.classList.add('hidden');
          studentBtn.disabled = false;
          document.getElementById('connectionBadge').innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-400"></span> Signed in';
          const teacherBtn = document.getElementById('selectTeacherBtn');
          teacherBtn.classList.add('hidden');
          accountRole = 'student';
          // Keep the name field locked until the saved account name has been checked.
          // This prevents a brief editable state while the asynchronous profile lookup runs.
          const nameInputWhileLoading = document.getElementById('studentNameInput');
          if (nameInputWhileLoading) {
            nameInputWhileLoading.readOnly = true;
            nameInputWhileLoading.title = 'Checking your saved student name…';
          }
          try {
            const userRef = db.collection('users').doc(user.uid);
            await userRef.set({
              displayName: user.displayName || '',
              email: user.email || '',
              photoURL: user.photoURL || '',
              lastSignInAt: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            const profile = await userRef.get();
            const profileData = profile.exists ? profile.data() : {};
            studentProfileName = typeof profileData.studentName === 'string' ? profileData.studentName.trim() : '';
            const nameInput = document.getElementById('studentNameInput');
            if (nameInput) {
              nameInput.value = studentProfileName || user.displayName || (user.email || 'Student').split('@')[0];
              nameInput.readOnly = Boolean(studentProfileName);
              nameInput.title = studentProfileName ? 'This name is saved to your account and is used for every assignment.' : 'Choose your name the first time you join an assignment. It will be saved for future assignments.';
            }
            accountRole = profileData.role === 'teacher' ? 'teacher' : 'student';
            if (accountRole === 'student') {
              const directoryName = studentProfileName
                || (typeof user.displayName === 'string' ? user.displayName.trim() : '');
              if (directoryName) {
                const peerRef = db.collection('peerDirectory').doc(user.uid);
                const peerSnapshot = await peerRef.get();
                const peerData = peerSnapshot.exists ? peerSnapshot.data() : {};
                // Google display name makes signed-in students discoverable before their first assignment.
                // A chosen canonical name takes precedence and remains fixed afterwards.
                if (!peerSnapshot.exists
                    || peerData.nameSource !== 'chosen'
                    || (studentProfileName && peerData.studentName !== studentProfileName)) {
                  await peerRef.set({
                    studentName: directoryName,
                    nameSource: studentProfileName ? 'chosen' : (peerData.nameSource || 'profile'),
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                  }, { merge: true });
                }
              }
            }
          } catch (err) {
            console.warn('Profile/role lookup notice:', err);
            // If profile verification failed, keep the field locked rather than risk
            // suggesting that a different name can be saved for this account.
            const nameInput = document.getElementById('studentNameInput');
            if (nameInput) {
              nameInput.value = studentProfileName || user.displayName || (user.email || 'Student').split('@')[0];
              nameInput.readOnly = true;
              nameInput.title = 'Could not verify your saved name. Reload the page and try again before joining.';
            }
            showToast('Could not verify your saved student name. Reload the page before joining an assignment.', 'info');
          }
          if (accountRole === 'teacher') {
            teacherBtn.classList.remove('hidden');
            roleBadge.textContent = 'Teacher Account';
            roleBadge.className = 'bg-indigo-800 text-indigo-100 px-3 py-1 rounded-full font-medium shadow-inner';
          } else {
            roleBadge.textContent = 'Student Account';
            roleBadge.className = 'bg-emerald-800 text-emerald-100 px-3 py-1 rounded-full font-medium shadow-inner';
          }
          renderStudentHistory();

          // Shared links reopen an existing member's assignment directly; new students see the join form.
          const requestedJoinCode = new URLSearchParams(window.location.search).get('join');
          if (requestedJoinCode && !window.__stepJoinLinkHandled) {
            window.__stepJoinLinkHandled = true;
            const normalizedCode = requestedJoinCode.trim().toUpperCase();
            let reopenedExistingAssignment = false;
            try {
              reopenedExistingAssignment = await openJoinedAssignmentFromLink(normalizedCode);
            } catch (err) {
              console.warn('Could not check existing assignment membership:', err);
            }
            if (!reopenedExistingAssignment) {
              document.getElementById('joinCodeInput').value = normalizedCode;
              const nameInput = document.getElementById('studentNameInput');
              if (!nameInput.value.trim()) nameInput.value = user.displayName || '';
              await switchRole('student', { showJoinForm: true });
              document.getElementById('joinCodeInput').value = normalizedCode;
              nameInput.focus();
            }
          }
          else if (!window.__stepScreenRestoreHandled) {
            window.__stepScreenRestoreHandled = true;
            await restoreStepScreenState();
          }
        } else {
          signedOut.classList.remove('hidden');
          signedIn.classList.add('hidden');
          studentBtn.disabled = true;
          accountRole = 'student';
          document.getElementById('selectTeacherBtn').classList.add('hidden');
          roleBadge.textContent = 'Sign in required';
          roleBadge.className = 'bg-slate-700 text-slate-100 px-3 py-1 rounded-full font-medium shadow-inner';
          document.getElementById('connectionBadge').innerHTML = '<span class="w-2 h-2 rounded-full bg-amber-400"></span> Sign in required';
          if (historyUnsubscribe) { historyUnsubscribe(); historyUnsubscribe = null; }
          studentHistoryScreen.classList.add('hidden');
          studentJoinScreen.classList.add('hidden');
          workspaceScreen.classList.add('hidden');
          teacherDashboard.classList.add('hidden');
          roleSelectionScreen.classList.remove('hidden');
        }
      });
    } catch (err) {
      console.error("Firebase init failed:", err);
      document.getElementById('connectionBadge').innerHTML = '<span class="w-2 h-2 rounded-full bg-rose-400"></span> Offline Mode';
      showToast("Firebase initialization notice: " + err.message, "error");
    }

    document.getElementById('googleSignInBtn').addEventListener('click', async () => {
      try { await auth.signInWithPopup(googleProvider); }
      catch (err) {
        if (err.code === 'auth/popup-blocked' || err.code === 'auth/popup-closed-by-user') {
          try { await auth.signInWithRedirect(googleProvider); }
          catch (redirectErr) { showToast('Google sign-in failed: ' + redirectErr.message, 'error'); }
        } else showToast('Google sign-in failed: ' + err.message, 'error');
      }
    });
    document.getElementById('signOutBtn').addEventListener('click', async () => {
      try { await auth.signOut(); resetRole(); }
      catch (err) { showToast('Could not sign out: ' + err.message, 'error'); }
    });

    function getStoredAssignments() {
      try {
        return JSON.parse(localStorage.getItem('classkick_assignments') || '{}');
      } catch (e) {
        return {};
      }
    }

    function saveStoredAssignment(code, data) {
      try {
        const current = getStoredAssignments();
        current[code.toUpperCase()] = data;
        localStorage.setItem('classkick_assignments', JSON.stringify(current));
      } catch (e) {
        console.warn("LocalStorage save error:", e);
      }
    }

    let currentUserRole = null;
    let currentAssignmentId = null;
    let currentAssignmentData = null;
    let currentSessionCode = null;

    // Legacy records without classId are assigned to MB1.
    // Add future classes here; all new assignment/submission records carry this ID.
    const STEP_DEFAULT_CLASSES = [
      { id: 'MB1', name: 'MB1', description: 'Current class and existing saved work', builtIn: true }
    ];
    let STEP_CLASSES = [...STEP_DEFAULT_CLASSES];
    let classManagementBusy = false;

    async function loadClassRegistry() {
      if (!signedInUser || !db) return;
      try {
        const snapshot = await db.collection('classes').get();
        const byId = new Map(STEP_DEFAULT_CLASSES.map(item => [item.id, item]));
        snapshot.docs.forEach(doc => {
          const data = doc.data() || {};
          if (data.deleted === true) { byId.delete(doc.id); return; }
          if (typeof data.name === 'string' && data.name.trim()) {
            byId.set(doc.id, {
              id: doc.id, name: data.name.trim(),
              description: data.description || 'Class assignments and student work',
              ownerTeacherId: data.ownerTeacherId || null, builtIn: doc.id === 'MB1'
            });
          }
        });
        STEP_CLASSES = [...byId.values()].sort((a, b) =>
          a.id === 'MB1' ? -1 : b.id === 'MB1' ? 1 : a.name.localeCompare(b.name));
      } catch (err) { console.error('Could not load class registry:', err); }
    }

    function renderClassManagementControls() {
      const controls = document.getElementById('classManagementControls');
      if (controls) controls.classList.toggle('hidden',
        !(pendingPortalRole === 'teacher' && accountRole === 'teacher'));
    }
    let currentClassId = 'MB1';
    let selectedClassId = 'MB1';
    let pendingPortalRole = null;

    function activeClassStorageKey(uid = signedInUser?.uid) {
      return uid ? 'step_active_class_' + uid : null;
    }
    function loadActiveClassId(uid = signedInUser?.uid) {
      try {
        const key = activeClassStorageKey(uid);
        const stored = key ? localStorage.getItem(key) : null;
        return STEP_CLASSES.some(item => item.id === stored) ? stored : 'MB1';
      } catch (err) { return 'MB1'; }
    }
    function isCurrentClass(record) {
      return (record?.classId || 'MB1') === currentClassId;
    }
    function renderClassChoices() {
      const container = document.getElementById('classOptionsContainer');
      if (!container) return;
      container.innerHTML = '';
      const visibleClasses = pendingPortalRole === 'teacher'
        ? STEP_CLASSES.filter(item => !item.ownerTeacherId || item.ownerTeacherId === signedInUser?.uid)
        : STEP_CLASSES;
      visibleClasses.forEach(item => {
        const card = document.createElement('div');
        card.className = 'rounded-2xl border-2 p-3 transition ' +
          (selectedClassId === item.id
            ? 'border-indigo-600 bg-indigo-50 ring-2 ring-indigo-100'
            : 'border-slate-200 bg-white hover:border-indigo-300');
        const selectButton = document.createElement('button');
        selectButton.type = 'button';
        selectButton.setAttribute('aria-pressed', String(selectedClassId === item.id));
        selectButton.className = 'w-full rounded-xl p-2 text-left';
        selectButton.innerHTML = '<div class="flex items-start justify-between gap-3"><div><div class="class-option-name text-xl font-extrabold text-slate-800"></div><p class="class-option-description text-sm text-slate-500 mt-2"></p></div><span class="class-selected-indicator w-7 h-7 rounded-full flex items-center justify-center"></span></div>';
        selectButton.querySelector('.class-option-name').textContent = item.name;
        selectButton.querySelector('.class-option-description').textContent = item.description;
        const indicator = selectButton.querySelector('.class-selected-indicator');
        indicator.className += selectedClassId === item.id ? ' bg-indigo-600 text-white' : ' bg-slate-100 text-slate-400';
        indicator.innerHTML = selectedClassId === item.id ? '<i class="fa-solid fa-check"></i>' : '<i class="fa-solid fa-circle"></i>';
        selectButton.addEventListener('click', () => {
          selectedClassId = item.id;
          renderClassChoices();
          saveStepScreenState();
        });
        card.appendChild(selectButton);
        if (pendingPortalRole === 'teacher' && accountRole === 'teacher') {
          const canDelete = !item.ownerTeacherId || item.ownerTeacherId === signedInUser?.uid;
          const deleteButton = document.createElement('button');
          deleteButton.type = 'button';
          deleteButton.dataset.deleteClass = item.id;
          deleteButton.className = 'mt-3 w-full rounded-lg border border-red-200 px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50';
          deleteButton.textContent = canDelete ? 'Delete Class' : 'Created by another teacher';
          deleteButton.disabled = !canDelete || classManagementBusy;
          deleteButton.addEventListener('click', () => deleteClassFromSelection(item.id));
          card.appendChild(deleteButton);
        }
        container.appendChild(card);
      });
      renderClassManagementControls();
    }

    async function createClassFromForm() {
      if (classManagementBusy) return;
      if (!signedInUser || !db || pendingPortalRole !== 'teacher' || accountRole !== 'teacher') {
        showToast('Only an authenticated teacher can create a class.', 'error'); return;
      }
      const nameInput = document.getElementById('newClassName');
      const descriptionInput = document.getElementById('newClassDescription');
      const name = (nameInput?.value || '').trim();
      const description = (descriptionInput?.value || '').trim();
      if (!name) { showToast('Enter a class name first.', 'error'); nameInput?.focus(); return; }
      if (name.length > 60 || description.length > 160) {
        showToast('Class name must be 60 characters or fewer; description must be 160 characters or fewer.', 'error'); return;
      }
      if (STEP_CLASSES.some(item => item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        showToast('A class with that name already exists.', 'error'); return;
      }
      classManagementBusy = true;
      const createBtn = document.getElementById('createClassBtn');
      if (createBtn) createBtn.disabled = true;
      try {
        const ref = db.collection('classes').doc();
        await ref.set({
          name, description: description || 'Class assignments and student work',
          ownerTeacherId: signedInUser.uid,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(), deleted: false
        });
        nameInput.value = '';
        descriptionInput.value = '';
        await loadClassRegistry();
        selectedClassId = ref.id;
        renderClassChoices();
        showToast('Class "' + name + '" created.', 'success');
        saveStepScreenState();
      } catch (err) {
        console.error('Class creation failed:', err);
        showToast('Could not create class: ' + err.message, 'error');
      } finally {
        classManagementBusy = false;
        if (createBtn) createBtn.disabled = false;
      }
    }

    async function deleteStoragePrefix(prefix) {
      if (!storage) return;
      const result = await storage.ref(prefix).listAll();
      for (const item of result.items) {
        await item.delete().catch(err => { if (err.code !== 'storage/object-not-found') throw err; });
      }
      for (const folder of result.prefixes) await deleteStoragePrefix(folder.fullPath);
    }

    async function deleteClassAssignmentData(assignmentId, assignment) {
      if (assignment?.teacherId !== signedInUser?.uid) {
        throw new Error('This account does not own assignment ' + assignmentId + '. The class was not fully deleted.');
      }
      const ref = db.collection('assignments').doc(assignmentId);
      const students = await ref.collection('students').get();
      for (const studentDoc of students.docs) {
        const slides = await studentDoc.ref.collection('slides').get();
        for (const slide of slides.docs) {
          const path = slide.data()?.canvasStoragePath;
          if (path && storage) await storage.ref(path).delete().catch(err => {
            if (err.code !== 'storage/object-not-found') throw err;
          });
        }
        for (let i = 0; i < slides.docs.length; i += 400) {
          const batch = db.batch();
          slides.docs.slice(i, i + 400).forEach(doc => batch.delete(doc.ref));
          await batch.commit();
        }
        await studentDoc.ref.delete();
        const userRef = db.collection('users').doc(studentDoc.id);
        const submissionRef = userRef.collection('submissions').doc(assignmentId);
        const submission = await submissionRef.get();
        if (submission.exists) await submissionRef.delete();
        const events = await userRef.collection('peerHelpEvents').where('assignmentId', '==', assignmentId).get();
        for (let i = 0; i < events.docs.length; i += 400) {
          const batch = db.batch();
          events.docs.slice(i, i + 400).forEach(doc => batch.delete(doc.ref));
          await batch.commit();
        }
      }
      const teacherEvents = await db.collection('users').doc(signedInUser.uid)
        .collection('peerHelpEvents').where('assignmentId', '==', assignmentId).get();
      for (let i = 0; i < teacherEvents.docs.length; i += 400) {
        const batch = db.batch();
        teacherEvents.docs.slice(i, i + 400).forEach(doc => batch.delete(doc.ref));
        await batch.commit();
      }
      const assigned = await ref.collection('assignedStudents').get();
      for (let i = 0; i < assigned.docs.length; i += 400) {
        const batch = db.batch();
        assigned.docs.slice(i, i + 400).forEach(doc => batch.delete(doc.ref));
        await batch.commit();
      }
      const requests = await ref.collection('helpRequests').get();
      for (const request of requests.docs) {
        const slides = await request.ref.collection('slides').get();
        for (let i = 0; i < slides.docs.length; i += 400) {
          const batch = db.batch();
          slides.docs.slice(i, i + 400).forEach(doc => batch.delete(doc.ref));
          await batch.commit();
        }
        await request.ref.delete();
      }
      for (const collectionName of ['helpRequestOwners', 'helpLocks']) {
        const snapshot = await ref.collection(collectionName).get();
        for (let i = 0; i < snapshot.docs.length; i += 400) {
          const batch = db.batch();
          snapshot.docs.slice(i, i + 400).forEach(doc => batch.delete(doc.ref));
          await batch.commit();
        }
      }
      if (assignment?.sessionCode) {
        const lookupRef = db.collection('assignmentLookups').doc(assignment.sessionCode);
        const lookup = await lookupRef.get();
        if (lookup.exists) await lookupRef.delete();
      }
      await deleteStoragePrefix('student-work/' + assignmentId);
      await ref.delete();
    }

    async function deleteClassFromSelection(classId) {
      if (classManagementBusy) return;
      if (!signedInUser || !db || pendingPortalRole !== 'teacher' || accountRole !== 'teacher') {
        showToast('Only an authenticated teacher can delete a class.', 'error'); return;
      }
      const target = STEP_CLASSES.find(item => item.id === classId);
      if (!target) { showToast('Class not found. Refresh the class list and try again.', 'error'); return; }
      if (target.ownerTeacherId && target.ownerTeacherId !== signedInUser.uid) {
        showToast('Only the teacher who created this class can delete it.', 'error'); return;
      }
      const typed = window.prompt(
        'PERMANENT DELETION\n\nThis will delete class "' + target.name +
        '", all its assignments, student canvases, submitted work, help requests, and saved files. This cannot be undone.\n\nTo confirm, type DELETE in capital letters:'
      );
      if (typed !== 'DELETE') {
        showToast('Class deletion cancelled. No data was deleted.', 'info'); return;
      }
      if (!window.confirm('Final confirmation: permanently delete ALL data belonging to class "' + target.name + '"?')) return;
      classManagementBusy = true;
      try {
        const snapshot = await db.collection('assignments').where('teacherId', '==', signedInUser.uid).get();
        const assignments = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }))
          .filter(item => (item.classId || 'MB1') === classId);
        for (const assignment of assignments) await deleteClassAssignmentData(assignment.id, assignment);

        const classRef = db.collection('classes').doc(classId);
        const classDoc = await classRef.get();
        if (classDoc.exists) {
          const data = classDoc.data() || {};
          if (data.ownerTeacherId && data.ownerTeacherId !== signedInUser.uid) {
            throw new Error('Only the class creator can delete this class.');
          }
          await classRef.set({
            name: data.name || target.name,
            description: data.description || target.description || '',
            ownerTeacherId: data.ownerTeacherId || signedInUser.uid,
            deleted: true, deletedAt: firebase.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
        } else if (classId === 'MB1') {
          await classRef.set({
            name: 'MB1', description: 'Built-in class', ownerTeacherId: signedInUser.uid,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(), deleted: true
          });
        }
        STEP_CLASSES = STEP_CLASSES.filter(item => item.id !== classId);
        if (currentClassId === classId) currentClassId = STEP_CLASSES[0]?.id || 'MB1';
        if (selectedClassId === classId) selectedClassId = STEP_CLASSES[0]?.id || 'MB1';
        try { const key = activeClassStorageKey(); if (key) localStorage.setItem(key, currentClassId); } catch (_) {}
        await loadClassRegistry();
        renderClassChoices();
        saveStepScreenState();
        showToast('Class "' + target.name + '" and its class-owned data were deleted.', 'success');
      } catch (err) {
        console.error('Class deletion failed:', err);
        showToast('Class deletion stopped before completion: ' + err.message + '. Some records may already have been deleted; inspect Firebase before retrying.', 'error');
        await loadClassRegistry();
        renderClassChoices();
      } finally {
        classManagementBusy = false;
        renderClassChoices();
      }
    }

    let studentId = null;
    let studentName = null;
    let inspectingStudentId = null;
    // Preserve the teacher dashboard's position while temporarily inspecting student work.
    let teacherDashboardScrollY = 0;

    // Restore the user's last in-app screen after a browser refresh. sessionStorage
    // keeps this state scoped to the current tab and avoids stale cross-session reopening.
    const STEP_SCREEN_STATE_KEY = 'step_screen_state_v1';
    let restoringStepScreen = false;

    function saveStepScreenState() {
      if (restoringStepScreen || !signedInUser) return;
      const isVisible = element => Boolean(element && !element.classList.contains('hidden'));
      let screen = 'role';
      const classScreen = document.getElementById('classSelectionScreen');
      if (isVisible(classScreen)) screen = 'class-selection';
      else if (isVisible(workspaceScreen)) screen = 'workspace';
      else if (isVisible(teacherDashboard)) screen = 'teacher-dashboard';
      else if (isVisible(studentJoinScreen)) screen = 'student-join';
      else if (isVisible(studentHistoryScreen)) screen = 'student-history';
      else if (isVisible(roleSelectionScreen)) screen = 'role';

      const state = {
        uid: signedInUser.uid,
        screen,
        role: currentUserRole || (pendingPortalRole || (accountRole === 'teacher' ? 'teacher' : 'student')),
        pendingRole: pendingPortalRole,
        classId: currentClassId,
        selectedClassId,
        assignmentId: currentAssignmentId || null,
        sessionCode: currentSessionCode || '',
        studentId: inspectingStudentId || null,
        studentName: studentName || '',
        submissionStatus: currentSubmissionStatus || 'in-progress',
        slideIndex: Number.isInteger(currentSlideIndex) ? currentSlideIndex : 0,
        scrollY: Math.max(0, window.scrollY || document.documentElement.scrollTop || 0),
        savedAt: Date.now()
      };
      try { sessionStorage.setItem(STEP_SCREEN_STATE_KEY, JSON.stringify(state)); }
      catch (err) { console.warn('Could not save screen state:', err); }
    }

    function readStepScreenState() {
      try {
        const state = JSON.parse(sessionStorage.getItem(STEP_SCREEN_STATE_KEY) || 'null');
        if (!state || !signedInUser || state.uid !== signedInUser.uid) return null;
        // Do not restore old screens after a long gap or a deliberate new session.
        if (Date.now() - Number(state.savedAt || 0) > 12 * 60 * 60 * 1000) return null;
        return state;
      } catch (err) { return null; }
    }

    async function restoreStepScreenState() {
      const state = readStepScreenState();
      if (!state) return false;
      restoringStepScreen = true;
      try {
        currentClassId = state.classId || loadActiveClassId();
        selectedClassId = state.selectedClassId || currentClassId;
        if (state.screen === 'class-selection') {
          pendingPortalRole = state.pendingRole || state.role || (accountRole === 'teacher' ? 'teacher' : 'student');
          roleSelectionScreen.classList.add('hidden');
          document.getElementById('classSelectionScreen').classList.remove('hidden');
          await loadClassRegistry();
          renderClassChoices();
          return true;
        }
        if (state.screen === 'workspace' && state.role === 'teacher' && state.studentId && state.assignmentId) {
          await switchRole('teacher');
          const assignmentDoc = await db.collection('assignments').doc(state.assignmentId).get();
          if (!assignmentDoc.exists) return false;
          const studentDoc = await db.collection('assignments').doc(state.assignmentId)
            .collection('students').doc(state.studentId).get();
          if (!studentDoc.exists) return false;
          const record = studentDoc.data() || {};
          currentAssignmentId = state.assignmentId;
          currentAssignmentData = assignmentDoc.data() || {};
          currentSessionCode = state.sessionCode || currentAssignmentData.sessionCode || '';
          currentUserRole = 'teacher';
          currentSlideIndex = Math.max(0, Number(state.slideIndex) || 0);
          openWorkspaceForInspection(
            state.studentId,
            record.name || state.studentName || 'Student',
            record.status || state.submissionStatus || 'submitted',
            { ...record, id: state.studentId, studentUid: state.studentId }
          );
          requestAnimationFrame(() => window.scrollTo(0, state.scrollY || 0));
          return true;
        }

        if (state.screen === 'workspace' && state.role === 'student' && state.assignmentId) {
          if (state.sessionCode) {
            const reopened = await openJoinedAssignmentFromLink(state.sessionCode);
            if (reopened) {
              currentSlideIndex = Math.max(0, Number(state.slideIndex) || 0);
              setupSlideWorkspace();
              return true;
            }
          }
          await reopenSavedAssignment(state.assignmentId, {
            status: state.submissionStatus || 'in-progress',
            sessionCode: state.sessionCode || '',
            assignedStudentKey: null
          });
          currentSlideIndex = Math.max(0, Number(state.slideIndex) || 0);
          setupSlideWorkspace();
          return true;
        }

        if (state.screen === 'teacher-dashboard' && accountRole === 'teacher') {
          await switchRole('teacher');
          requestAnimationFrame(() => window.scrollTo(0, state.scrollY || 0));
          return true;
        }
        if (state.screen === 'student-join') {
          await switchRole('student', { showJoinForm: true });
          document.getElementById('joinCodeInput').value = state.sessionCode || '';
          return true;
        }
        if (state.screen === 'student-history') {
          await switchRole('student');
          requestAnimationFrame(() => window.scrollTo(0, state.scrollY || 0));
          return true;
        }
        return false;
      } catch (err) {
        console.warn('Could not restore the previous screen; opening the default view instead:', err);
        return false;
      } finally {
        restoringStepScreen = false;
      }
    }

    // pagehide fires on reload/navigation and captures the latest screen and canvas page.
    window.addEventListener('pagehide', saveStepScreenState);

    // Teacher-controlled help feature. Peer Help is opt-in; missing flags default to disabled.
    function isPeerHelpEnabled() { return currentAssignmentData?.peerHelpEnabled === true; }

    // Peer Help state. Requester identity is stored only in the private owner mapping.
    let activeHelpRequestId = null;
    let activeHelpRequestData = null;
    let activeHelpMode = null; // 'helper' or 'teacher'
    let requesterHelpLock = false;
    let hasOpenOwnedHelpRequest = false;
    const ownedHelpRequestState = new Map();
    // IDs cleared from the requester's on-screen activity log; records remain intact for teachers/helpers.
    const clearedOwnedHelpLogIds = new Set();

    function ownedHelpLogStorageKey() {
      return currentAssignmentId && signedInUser
        ? `step_cleared_help_log_${currentAssignmentId}_${signedInUser.uid}`
        : null;
    }

    function loadClearedOwnedHelpLogIds() {
      clearedOwnedHelpLogIds.clear();
      const key = ownedHelpLogStorageKey();
      if (!key) return;
      try {
        const ids = JSON.parse(localStorage.getItem(key) || '[]');
        if (Array.isArray(ids)) ids.forEach(id => { if (typeof id === 'string') clearedOwnedHelpLogIds.add(id); });
      } catch (err) {
        console.warn('Could not load cleared help log state:', err);
      }
    }
    let unsubHelpRequests = null;
    let unsubOwnedHelpRequests = null;
    const ownedHelpRequestListeners = new Map();
    const finishedOwnedHelpRequestListeners = new Set();
    let unsubTeacherHelpRequests = null;
    const teacherRequesterLabelCache = new Map();
    let unsubActiveHelpSession = null;
    let peerHelpListeningAssignmentId = null;
    const copiedHelpResults = new Set();
    const copyingHelpResults = new Set();
    const PEER_HELP_COLOUR = '#e11d48';


    let currentSlideIndex = 0;
    let activeTool = 'pen';
    let currentColor = '#1e293b';
    let currentLineWidth = 4;
    let isDrawing = false;
    let lastX = 0;
    let lastY = 0;
    let isStylusOnlyMode = true; // Default to Stylus Only Mode for active palm rejection

    let unsubAssignment = null;
    let unsubStudents = null;
    let unsubSlideWork = null;

    window.addEventListener('storage', (e) => {
      if (e.key === 'classkick_assignments' && currentSessionCode) {
        const stored = getStoredAssignments();
        if (stored[currentSessionCode]) {
          currentAssignmentData = stored[currentSessionCode];
        }
      }
    });

    const roleSelectionScreen = document.getElementById('roleSelectionScreen');
    const teacherDashboard = document.getElementById('teacherDashboard');
    const studentJoinScreen = document.getElementById('studentJoinScreen');
    const studentHistoryScreen = document.getElementById('studentHistoryScreen');
    const workspaceScreen = document.getElementById('workspaceScreen');
    const roleBadge = document.getElementById('roleBadge');
    const resetRoleBtn = document.getElementById('resetRoleBtn');
    const peersBtn = document.getElementById('peersBtn');
    const peersModal = document.getElementById('peersModal');
    const peersList = document.getElementById('peersList');
    const peersCount = document.getElementById('peersCount');

    const mainCanvas = document.getElementById('mainCanvas');
    const ctx = mainCanvas.getContext('2d');
    const canvasWrapper = document.getElementById('canvasWrapper');

    document.getElementById('toggleTeacherStudentStatsBtn').addEventListener('click', () => {
      const panel = document.getElementById('teacherStudentStatsPanel');
      const button = document.getElementById('toggleTeacherStudentStatsBtn');
      const chevron = document.getElementById('teacherStudentStatsChevron');
      const isOpening = panel.classList.contains('hidden');
      panel.classList.toggle('hidden', !isOpening);
      button.setAttribute('aria-expanded', String(isOpening));
      chevron.classList.toggle('rotate-180', isOpening);
      if (isOpening) loadTeacherStudentStats();
    });

    document.getElementById('selectTeacherBtn').addEventListener('click', () => switchRole('teacher', { fromWelcome: true }));
    document.getElementById('selectStudentBtn').addEventListener('click', () => switchRole('student', { fromWelcome: true }));

    document.getElementById('createClassBtn').addEventListener('click', createClassFromForm);
    document.getElementById('newClassName').addEventListener('keydown', event => {
      if (event.key === 'Enter') createClassFromForm();
    });

    document.getElementById('backToWelcomeFromClassBtn').addEventListener('click', () => {
      pendingPortalRole = null;
      document.getElementById('classSelectionScreen').classList.add('hidden');
      roleSelectionScreen.classList.remove('hidden');
      saveStepScreenState();
    });
    document.getElementById('continueWithClassBtn').addEventListener('click', async () => {
      if (!pendingPortalRole) {
        showToast('Choose Teacher Portal or Student Portal first.', 'error');
        return;
      }
      currentClassId = selectedClassId || 'MB1';
      try {
        const key = activeClassStorageKey();
        if (key) localStorage.setItem(key, currentClassId);
      } catch (err) { console.warn('Could not save selected class:', err); }
      saveStepScreenState();
      const role = pendingPortalRole;
      await switchRole(role, { skipClassSelection: true });
    });
    document.getElementById('historyJoinAssignmentBtn').addEventListener('click', () => {
      if (!signedInUser) return showToast('Sign in first.', 'error');
      studentHistoryScreen.classList.add('hidden');
      studentJoinScreen.classList.remove('hidden');
    });
    resetRoleBtn.addEventListener('click', resetRole);
    peersBtn.addEventListener('click', openPeersDirectory);
    document.getElementById('closePeersBtn').addEventListener('click', closePeersDirectory);
    peersModal.addEventListener('click', event => {
      if (event.target === peersModal) closePeersDirectory();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !peersModal.classList.contains('hidden')) closePeersDirectory();
    });

    function closePeersDirectory() {
      peersModal.classList.add('hidden');
      peersBtn.focus();
    }

    async function openPeersDirectory() {
      if (!signedInUser || !db) {
        showToast('Sign in to view the student directory.', 'error');
        return;
      }
      peersModal.classList.remove('hidden');
      peersCount.textContent = 'Loading students…';
      peersList.innerHTML = '<p class="text-sm text-slate-500">Loading student directory…</p>';
      document.getElementById('closePeersBtn').focus();

      try {
        // Re-sync the current signed-in student's minimal directory entry when Peers opens.
        // This also repairs a missed registration for an existing session without requiring
        // the student to sign out and sign back in.
        const profileSnapshot = await db.collection('users').doc(signedInUser.uid).get();
        const profileData = profileSnapshot.exists ? profileSnapshot.data() : {};
        const canonicalName = typeof profileData.studentName === 'string'
          ? profileData.studentName.trim()
          : '';
        const googleName = typeof signedInUser.displayName === 'string'
          ? signedInUser.displayName.trim()
          : '';
        const directoryName = canonicalName || googleName;

        if (profileData.role !== 'teacher' && directoryName) {
          const peerRef = db.collection('peerDirectory').doc(signedInUser.uid);
          const peerSnapshot = await peerRef.get();
          if (!peerSnapshot.exists) {
            await peerRef.set({
              studentName: directoryName,
              nameSource: canonicalName ? 'chosen' : 'profile',
              updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
          } else {
            const peerData = peerSnapshot.data() || {};
            // Never overwrite a name the student has already chosen.
            if (peerData.nameSource !== 'chosen' && peerData.studentName !== directoryName) {
              await peerRef.set({
                studentName: directoryName,
                nameSource: 'profile',
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
              }, { merge: true });
            }
          }
        }

        // Read only the deliberately public directory collection, never private user profiles.
        const snapshot = await db.collection('peerDirectory').get();
        const peers = snapshot.docs
          .filter(doc => doc.id !== signedInUser.uid)
          .map(doc => ({
            name: typeof doc.data().studentName === 'string' ? doc.data().studentName.trim() : ''
          }))
          .filter(peer => peer.name)
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

        peersCount.textContent = peers.length + (peers.length === 1 ? ' student' : ' students');
        peersList.innerHTML = '';
        if (!peers.length) {
          peersList.innerHTML = '<div class="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">No other student accounts found yet.</div>';
          return;
        }

        peers.forEach(peer => {
          const row = document.createElement('div');
          row.className = 'flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3';
          const avatar = document.createElement('div');
          avatar.className = 'w-10 h-10 shrink-0 rounded-full bg-sky-50 text-sky-700 flex items-center justify-center font-bold';
          avatar.textContent = peer.name.trim().charAt(0).toLocaleUpperCase() || '?';
          const name = document.createElement('div');
          name.className = 'min-w-0 flex-1 font-semibold text-slate-800 break-words';
          name.textContent = peer.name;
          const badgeArea = document.createElement('div');
          badgeArea.className = 'flex items-center gap-1.5 shrink-0';
          badgeArea.setAttribute('aria-label', 'Reserved achievement badge spaces');
          badgeArea.title = 'Achievement badges coming in a future update';
          for (let i = 0; i < 3; i++) {
            const slot = document.createElement('span');
            slot.className = 'w-7 h-7 rounded-full border border-dashed border-slate-300 bg-slate-50 inline-flex items-center justify-center text-slate-300 text-[10px]';
            slot.innerHTML = '<i class="fa-solid fa-award"></i>';
            slot.setAttribute('aria-hidden', 'true');
            badgeArea.appendChild(slot);
          }
          row.append(avatar, name, badgeArea);
          peersList.appendChild(row);
        });
      } catch (err) {
        console.error('Peers directory load failed:', err);
        peersCount.textContent = 'Could not load directory';
        peersList.innerHTML = '<div class="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">S.T.E.P. could not read the student directory. Your Firestore security rules must allow signed-in users to read the directory records. No account details have been changed.</div>';
      }
    }

    async function switchRole(role, options = {}) {
      if (!signedInUser) { showToast('Sign in with Google first.', 'error'); return; }

      // The teacher UI is not an authorization boundary, but it should still
      // avoid exposing teacher controls to accounts without an assigned role.
      if (role === 'teacher') {
        try {
          const profile = await db.collection('users').doc(signedInUser.uid).get();
          if (!profile.exists || profile.data().role !== 'teacher') {
            showToast('This Google account has not been assigned the teacher role.', 'error');
            return;
          }
        } catch (err) {
          console.error('Teacher role check failed:', err);
          showToast('Could not verify teacher access. Check your connection and try again.', 'error');
          return;
        }
      }

      if (options.fromWelcome && options.skipClassSelection !== true) {
        pendingPortalRole = role;
        selectedClassId = currentClassId;
        roleSelectionScreen.classList.add('hidden');
        document.getElementById('classSelectionScreen').classList.remove('hidden');
        resetRoleBtn.classList.add('hidden');
        await loadClassRegistry();
        renderClassChoices();
        saveStepScreenState();
        return;
      }

      currentUserRole = role;
      pendingPortalRole = null;
      const activeClassBadge = document.getElementById('activeClassBadge');
      if (activeClassBadge) {
        activeClassBadge.textContent = 'Class: ' + currentClassId;
        activeClassBadge.classList.remove('hidden');
      }
      document.getElementById('classSelectionScreen').classList.add('hidden');
      roleSelectionScreen.classList.add('hidden');
      saveStepScreenState();
      studentHistoryScreen.classList.add('hidden');
      resetRoleBtn.classList.remove('hidden');

      if (role === 'teacher') {
        peersBtn.classList.add('hidden');
        roleBadge.textContent = "Teacher Mode";
        roleBadge.className = "bg-indigo-800 text-indigo-100 px-3 py-1 rounded-full font-medium shadow-inner";
        teacherDashboard.classList.remove('hidden');
        renderTeacherAssignments();
      } else {
        peersBtn.classList.remove('hidden');
        roleBadge.textContent = "Student Mode";
        roleBadge.className = "bg-emerald-800 text-emerald-100 px-3 py-1 rounded-full font-medium shadow-inner";
        if (options.showJoinForm) {
          studentHistoryScreen.classList.add('hidden');
          studentJoinScreen.classList.remove('hidden');
        } else {
          studentJoinScreen.classList.add('hidden');
          studentHistoryScreen.classList.remove('hidden');
          renderStudentHistory();
        }
      }
      saveStepScreenState();
    }

    function resetRole() {
      stopStudentPreviewListeners();
      if (teacherStatsRefreshTimer) { clearTimeout(teacherStatsRefreshTimer); teacherStatsRefreshTimer = null; }
      if (unsubAssignment) unsubAssignment();
      if (unsubStudents) unsubStudents();
      if (unsubAssignedStudents) unsubAssignedStudents();
      if (unsubSlideWork) unsubSlideWork();
      if (teacherAssignmentsUnsubscribe) { teacherAssignmentsUnsubscribe(); teacherAssignmentsUnsubscribe = null; }

      currentUserRole = null;
      currentAssignmentId = null;
      currentAssignmentData = null;
      inspectingStudentId = null;
      currentAssignedStudents = [];
      currentJoinedStudents = [];
      currentAssignedStudentKey = null;
      currentSubmissionStatus = 'in-progress';

      teacherDashboard.classList.add('hidden');
      studentJoinScreen.classList.add('hidden');
      studentHistoryScreen.classList.add('hidden');
      workspaceScreen.classList.add('hidden');
      document.getElementById('teacherActiveSection').classList.add('hidden');
      document.getElementById('classSelectionScreen').classList.add('hidden');
      pendingPortalRole = null;
      
      roleSelectionScreen.classList.remove('hidden');
      resetRoleBtn.classList.add('hidden');
      const activeClassBadge = document.getElementById('activeClassBadge');
      if (activeClassBadge) activeClassBadge.classList.add('hidden');
      peersBtn.classList.add('hidden');
      closePeersDirectory();
      roleBadge.textContent = accountRole === 'teacher' ? 'Teacher Account' : 'Student Account';
      roleBadge.className = accountRole === 'teacher'
        ? 'bg-indigo-800 text-indigo-100 px-3 py-1 rounded-full font-medium shadow-inner'
        : 'bg-emerald-800 text-emerald-100 px-3 py-1 rounded-full font-medium shadow-inner';
    }

    document.getElementById('copyCodeBtn').addEventListener('click', () => {
      if (!currentSessionCode) return;
      const tempInput = document.createElement('input');
      tempInput.value = currentSessionCode;
      document.body.appendChild(tempInput);
      tempInput.select();
      document.execCommand('copy');
      document.body.removeChild(tempInput);
      showToast(`Copied code ${currentSessionCode} to clipboard!`, 'success');
    });

    document.getElementById('quickTestJoinBtn').addEventListener('click', () => {
      if (!currentSessionCode) return;
      switchRole('student');
      document.getElementById('joinCodeInput').value = currentSessionCode;
      document.getElementById('studentNameInput').value = "Test Student " + Math.floor(Math.random() * 100);
    });

    // ==========================================
    // TEACHER ASSIGNMENT CREATION
    // ==========================================
    const createAssignmentModal = document.getElementById('createAssignmentModal');
    const slidesConfigContainer = document.getElementById('slidesConfigContainer');
    const createAssignmentForm = document.getElementById('createAssignmentForm');
    const publishBtn = document.getElementById('publishBtn');
    let slideConfigCount = 0;

    document.getElementById('openCreateModalBtn').addEventListener('click', () => {
      slidesConfigContainer.innerHTML = '';
      slideConfigCount = 0;
      addSlideConfigRow();
      createAssignmentModal.classList.remove('hidden');
    });

    document.getElementById('closeModalBtn').addEventListener('click', () => createAssignmentModal.classList.add('hidden'));
    document.getElementById('cancelModalBtn').addEventListener('click', () => createAssignmentModal.classList.add('hidden'));
    document.getElementById('addSlideConfigBtn').addEventListener('click', addSlideConfigRow);

    function addSlideConfigRow() {
      slideConfigCount++;
      const slideDiv = document.createElement('div');
      slideDiv.className = "p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-3 relative slide-config-item";
      slideDiv.innerHTML = `
        <div class="flex justify-between items-center">
          <span class="font-bold text-xs text-indigo-600 uppercase">Slide ${slideConfigCount}</span>
          ${slideConfigCount > 1 ? `<button type="button" class="text-rose-500 hover:text-rose-700 text-xs font-semibold remove-slide-btn"><i class="fa-solid fa-trash"></i> Remove</button>` : ''}
        </div>
        <div>
          <label class="block text-xs font-medium text-slate-600 mb-1">Question</label>
          <input type="text" class="slide-prompt-input w-full px-3 py-1.5 text-sm border border-slate-300 rounded focus:outline-none focus:ring-1 focus:ring-indigo-500" placeholder="Enter the question (optional if using an image)">
        </div>
        <div class="space-y-2">
          <label class="block text-xs font-medium text-slate-600">Question Image (Optional)</label>
          <div class="flex flex-wrap items-center gap-2">
            <button type="button" class="select-question-image-btn bg-sky-50 hover:bg-sky-100 text-sky-700 border border-sky-200 px-3 py-1.5 rounded-lg text-sm font-medium"><i class="fa-solid fa-images"></i> Add Image</button>
            <span class="question-image-name text-xs text-slate-500">No image selected</span>
            <button type="button" class="remove-question-image-btn hidden text-xs text-rose-600 hover:text-rose-700 font-medium">Remove image</button>
          </div>
          <input type="file" class="question-image-input hidden" accept="image/*" aria-label="Choose a question image from device">
          <img class="question-image-preview hidden max-h-40 max-w-full rounded border border-slate-200 object-contain" alt="Question image preview">
          <p class="text-xs text-slate-500">Choose a picture or worksheet from your device. It will appear as the slide background for students.</p>
        </div>
        <div>
          <label class="block text-xs font-medium text-slate-600 mb-1">Background Image URL (Optional)</label>
          <input type="url" class="slide-bg-input w-full px-3 py-1.5 text-sm border border-slate-300 rounded focus:outline-none focus:ring-1 focus:ring-indigo-500" placeholder="https://example.com/worksheet.png">
        </div>
      `;

      slidesConfigContainer.appendChild(slideDiv);

      const imageInput = slideDiv.querySelector('.question-image-input');
      const imageName = slideDiv.querySelector('.question-image-name');
      const imagePreview = slideDiv.querySelector('.question-image-preview');
      const removeImageBtn = slideDiv.querySelector('.remove-question-image-btn');
      slideDiv._questionImageFile = null;

      slideDiv.querySelector('.select-question-image-btn').addEventListener('click', () => {
        imageInput.value = '';
        imageInput.click();
      });
      imageInput.addEventListener('change', () => {
        const file = imageInput.files && imageInput.files[0];
        if (!file) return;
        if (!file.type.startsWith('image/')) {
          showToast('Please choose a valid image file.', 'error');
          imageInput.value = '';
          return;
        }
        slideDiv._questionImageFile = file;
        imageName.textContent = file.name;
        imagePreview.src = URL.createObjectURL(file);
        imagePreview.classList.remove('hidden');
        removeImageBtn.classList.remove('hidden');
      });
      removeImageBtn.addEventListener('click', () => {
        slideDiv._questionImageFile = null;
        imageInput.value = '';
        imageName.textContent = 'No image selected';
        imagePreview.removeAttribute('src');
        imagePreview.classList.add('hidden');
        removeImageBtn.classList.add('hidden');
      });

      const removeBtn = slideDiv.querySelector('.remove-slide-btn');
      if (removeBtn) {
        removeBtn.addEventListener('click', () => {
          slideDiv.remove();
          reindexSlideConfigs();
        });
      }
    }

    function compressQuestionImage(file) {
      return new Promise((resolve, reject) => {
        const objectUrl = URL.createObjectURL(file);
        const image = new Image();
        image.onload = () => {
          try {
            const maxDimension = 1400;
            const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
            const context = canvas.getContext('2d');
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            URL.revokeObjectURL(objectUrl);
            // Compress uploaded question images to reduce Firestore assignment document size.
            resolve(canvas.toDataURL('image/jpeg', 0.78));
          } catch (error) {
            URL.revokeObjectURL(objectUrl);
            reject(error);
          }
        };
        image.onerror = () => {
          URL.revokeObjectURL(objectUrl);
          reject(new Error('Unable to read question image.'));
        };
        image.src = objectUrl;
      });
    }

    function reindexSlideConfigs() {
      const items = slidesConfigContainer.querySelectorAll('.slide-config-item');
      slideConfigCount = items.length;
      items.forEach((item, idx) => {
        item.querySelector('span').textContent = `Slide ${idx + 1}`;
      });
    }

    createAssignmentForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const title = document.getElementById('assignTitleInput').value.trim();
      const desc = document.getElementById('assignDescInput').value.trim();
      const classLabel = document.getElementById('assignClassLabelInput').value.trim();

      if (!title) {
        showToast("Please enter an assignment title", "error");
        return;
      }

      const slideItems = slidesConfigContainer.querySelectorAll('.slide-config-item');
      const slides = [];

      try {
        for (const item of slideItems) {
          const prompt = item.querySelector('.slide-prompt-input').value.trim();
          const bgUrl = item.querySelector('.slide-bg-input').value.trim();
          let questionImageUrl = '';
          if (item._questionImageFile) {
            questionImageUrl = await compressQuestionImage(item._questionImageFile);
          }
          slides.push({
            prompt,
            questionImage: questionImageUrl,
            bgUrl
          });
        }
      } catch (err) {
        console.error('Question image processing failed:', err);
        showToast('Could not process a question image. Please try a smaller image.', 'error');
        publishBtn.disabled = false;
        publishBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-up"></i> <span>Publish Assignment</span>';
        return;
      }

      if (slides.length === 0) {
        showToast("Add at least one slide", "error");
        return;
      }

      publishBtn.disabled = true;
      publishBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> <span>Publishing...</span>`;

      const code = Math.random().toString(36).substring(2, 8).toUpperCase();
      if (!signedInUser) {
        showToast('Sign in before creating assignments.', 'error');
        publishBtn.disabled = false;
        publishBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-up"></i> <span>Publish Assignment</span>';
        return;
      }
      const newAssignment = {
        title,
        description: desc,
        teacherId: signedInUser.uid,
        sessionCode: code,
        classId: currentClassId,
        slides: slides,
        createdAt: new Date().toISOString(),
        status: 'published',
        classLabel,
        assignedStudentCount: 0,
        peerHelpEnabled: false
      };

      let docId = "assign_" + code;
      saveStoredAssignment(code, { ...newAssignment, id: docId });

      try {
        if (!db) throw new Error('Firebase is not available. Check your connection and Firebase configuration.');

        await db.collection('assignments').doc(docId).set({
          ...newAssignment,
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        // Limited lookup record: it does not contain slide prompts, backgrounds, or student work.
        await db.collection('assignmentLookups').doc(code).set({
          assignmentId: docId,
          sessionCode: code,
          classId: currentClassId,
          teacherId: signedInUser.uid,
          title: title,
          status: 'published',
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });


        currentAssignmentId = docId;
        currentSessionCode = code;
        currentAssignmentData = newAssignment;
        saveStoredAssignment(code, { ...newAssignment, id: docId });

        createAssignmentModal.classList.add('hidden');
        createAssignmentForm.reset();
        showToast(`Published! Share session code ${code} with your students.`, "success");
        renderTeacherAssignments();
        loadTeacherAssignmentView(docId);
      } catch (err) {
        console.error("Assignment publish failed:", err);
        showToast('Could not publish assignment to Firebase: ' + err.message, 'error');
      } finally {
        publishBtn.disabled = false;
        publishBtn.innerHTML = `<i class="fa-solid fa-cloud-arrow-up"></i> <span>Publish Assignment</span>`;
      }
    });

    // ==========================================
    // TEACHER LIVE MONITORING
    // ==========================================
    function getAssignmentStudentLink() {
      const code = currentAssignmentData?.sessionCode || currentSessionCode;
      if (!code) return '';
      const url = new URL(window.location.href);
      url.search = '';
      url.hash = '';
      url.searchParams.set('join', code);
      return url.toString();
    }

    function updateAssignmentStudentLink() {
      const input = document.getElementById('assignmentStudentLink');
      if (input) input.value = getAssignmentStudentLink();
    }

    document.getElementById('copyAssignmentLinkBtn').addEventListener('click', async () => {
      const link = getAssignmentStudentLink();
      if (!link) return showToast('No assignment link is available yet.', 'error');
      try {
        await navigator.clipboard.writeText(link);
        showToast('Student assignment link copied.', 'success');
      } catch (err) {
        const input = document.getElementById('assignmentStudentLink');
        if (input) { input.focus(); input.select(); }
        showToast('Select and copy the student link shown below.', 'info');
      }
    });

    function loadTeacherAssignmentView(assignmentId) {
      document.getElementById('teacherActiveSection').classList.remove('hidden');

      document.getElementById('currentAssignmentTitle').textContent = currentAssignmentData.title || 'Assignment';
      document.getElementById('currentAssignmentDesc').textContent = currentAssignmentData.description || 'No instructions provided.';
      document.getElementById('currentSessionCode').textContent = currentAssignmentData.sessionCode || '------';
      updateAssignmentStudentLink();
      updatePeerHelpToggleUI();
      if (currentUserRole === 'teacher') startTeacherHelpMonitor(assignmentId);

      if (!db) {
        currentJoinedStudents = [];
        currentAssignedStudents = [];
        renderStudentGrid([]);
        return;
      }

      // Backfill a limited lookup record when a teacher opens an existing assignment.
      if (signedInUser && currentAssignmentData?.sessionCode) {
        db.collection('assignmentLookups').doc(currentAssignmentData.sessionCode).set({
          assignmentId,
          sessionCode: currentAssignmentData.sessionCode,
          classId: currentAssignmentData.classId || 'MB1',
          teacherId: signedInUser.uid,
          title: currentAssignmentData.title || 'Assignment',
          status: currentAssignmentData.status || 'published',
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true }).catch(err => console.warn('Could not sync session-code lookup:', err));
      }

      // Changing assignments must not leave preview listeners attached to the old roster.
      stopStudentPreviewListeners();
      if (unsubAssignment) unsubAssignment();
      unsubAssignment = db.collection('assignments').doc(assignmentId).onSnapshot(doc => {
        if (!doc.exists) return;
        currentAssignmentData = { id: doc.id, ...doc.data() };
        document.getElementById('currentAssignmentTitle').textContent = currentAssignmentData.title || 'Assignment';
        document.getElementById('currentAssignmentDesc').textContent = currentAssignmentData.description || 'No instructions provided.';
        document.getElementById('currentSessionCode').textContent = currentAssignmentData.sessionCode || '------';
        updateAssignmentStudentLink();
        updatePeerHelpToggleUI();
        renderStudentGrid(mergeCurrentTeacherRoster());
      }, err => console.warn('Assignment snapshot notice:', err));

      // Refresh cross-assignment statistics only when roster membership or status changes.
      // Changes to helpRequested/helpQuestion and other non-status fields should not trigger
      // another set of reads across every assignment.
      const joinedStatusById = new Map();
      const assignedStatusById = new Map();
      const hasStatusChanges = (snapshot, previousStatuses) => {
        let changed = snapshot.docs.length !== previousStatuses.size;
        const nextStatuses = new Map();
        snapshot.docs.forEach(doc => {
          const status = String((doc.data() || {}).status || '').trim().toLowerCase();
          nextStatuses.set(doc.id, status);
          if (!previousStatuses.has(doc.id) || previousStatuses.get(doc.id) !== status) changed = true;
        });
        previousStatuses.clear();
        nextStatuses.forEach((status, id) => previousStatuses.set(id, status));
        return changed;
      };

      if (unsubStudents) unsubStudents();
      unsubStudents = db.collection('assignments').doc(assignmentId).collection('students').onSnapshot(snapshot => {
        const statusChanged = hasStatusChanges(snapshot, joinedStatusById);
        currentJoinedStudents = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        renderTeacherRoster();
        if (statusChanged) scheduleTeacherStudentStatsRefresh();
      }, err => {
        console.warn('Student listener notice:', err);
        currentJoinedStudents = [];
        joinedStatusById.clear();
        renderTeacherRoster();
      });

      if (unsubAssignedStudents) unsubAssignedStudents();
      currentAssignedStudents = [];
      // Listen to assignment-targeted records as well; submission/review updates these records.
      unsubAssignedStudents = db.collection('assignments').doc(assignmentId).collection('assignedStudents').onSnapshot(snapshot => {
        const statusChanged = hasStatusChanges(snapshot, assignedStatusById);
        currentAssignedStudents = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        renderTeacherRoster();
        if (statusChanged) scheduleTeacherStudentStatsRefresh();
      }, err => {
        console.warn('Assigned-student listener notice:', err);
        currentAssignedStudents = [];
        assignedStatusById.clear();
        renderTeacherRoster();
      });
    }

    document.getElementById('deleteTeacherAssignmentBtn').addEventListener('click', () => {
      if (currentAssignmentId && currentAssignmentData) deleteTeacherAssignment(currentAssignmentId, currentAssignmentData);
    });

    async function deleteTeacherAssignment(assignmentId, assignment) {
      const title = assignment?.title || 'this assignment';
      if (!window.confirm(`Delete "${title}" and ALL student work for it? This cannot be undone.`)) return;
      if (!signedInUser || !db || assignment?.teacherId !== signedInUser.uid) {
        showToast('Only the assignment owner can delete it.', 'error'); return;
      }
      try {
        const ref = db.collection('assignments').doc(assignmentId);
        const students = await ref.collection('students').get();
        for (const studentDoc of students.docs) {
          const slides = await studentDoc.ref.collection('slides').get();
          for (let i = 0; i < slides.docs.length; i += 400) {
            const batch = db.batch(); slides.docs.slice(i, i + 400).forEach(d => batch.delete(d.ref)); await batch.commit();
          }
          await studentDoc.ref.delete();
          await db.collection('users').doc(studentDoc.id).collection('submissions').doc(assignmentId).delete().catch(() => {});
        }
        const assigned = await ref.collection('assignedStudents').get();
        for (let i = 0; i < assigned.docs.length; i += 400) {
          const batch = db.batch(); assigned.docs.slice(i, i + 400).forEach(d => batch.delete(d.ref)); await batch.commit();
        }
        if (assignment?.sessionCode) await db.collection('assignmentLookups').doc(assignment.sessionCode).delete();
        await ref.delete();
        if (currentAssignmentId === assignmentId) {
          if (unsubAssignment) unsubAssignment();
          if (unsubStudents) unsubStudents();
          if (unsubSlideWork) unsubSlideWork();
          currentAssignmentId = null; currentAssignmentData = null; inspectingStudentId = null;
          document.getElementById('teacherActiveSection').classList.add('hidden');
        }
        showToast('Assignment and its student work were deleted.', 'success');
        renderTeacherAssignments();
      } catch (err) {
        console.error('Assignment deletion failed:', err);
        showToast('Could not fully delete assignment: ' + err.message, 'error');
      }
    }

    async function deleteStudentAssignment(assignmentId, title) {
      if (!signedInUser || !db || !window.confirm(`Remove "${title}" and your saved work from your history? Other students' work will not be deleted.`)) return;
      try {
        const studentRef = db.collection('assignments').doc(assignmentId).collection('students').doc(signedInUser.uid);
        const slides = await studentRef.collection('slides').get();
        for (let i = 0; i < slides.docs.length; i += 400) {
          const batch = db.batch(); slides.docs.slice(i, i + 400).forEach(d => batch.delete(d.ref)); await batch.commit();
        }
        const studentDoc = await studentRef.get();
        if (studentDoc.exists) {
          await studentRef.delete();
        }
        // A teacher may already have deleted the assignment and its student document.
        // Remove the remaining personal history record even when the assignment no longer exists.
        const submissionRef = db.collection('users').doc(signedInUser.uid).collection('submissions').doc(assignmentId);
        const submissionDoc = await submissionRef.get();
        if (submissionDoc.exists) await submissionRef.delete();
        showToast('Assignment removed from your work history.', 'success');
      } catch (err) {
        console.error('Student assignment deletion failed:', err);
        showToast('Could not remove this assignment: ' + err.message, 'error');
      }
    }

        async function loadTeacherStudentStats() {
      const body = document.getElementById('teacherStudentStatsBody');
      if (!body || !signedInUser || !db) return;
      try {
        const assignments = await db.collection('assignments').where('teacherId', '==', signedInUser.uid).get();
        const students = new Map();
        const studentRosterRefs = new Map();
        for (const assignment of assignments.docs) {
          if (!isCurrentClass(assignment.data())) continue;
          const [rosterSnapshot, assignedSnapshot] = await Promise.all([
            getTeacherRosterSnapshot(assignment.ref, 'students'),
            getTeacherRosterSnapshot(assignment.ref, 'assignedStudents')
          ]);
          rosterSnapshot.docs.forEach(doc => {
            const refs = studentRosterRefs.get(doc.id) || [];
            refs.push(doc.ref);
            studentRosterRefs.set(doc.id, refs);
          });
          const byIdentity = new Map();
          rosterSnapshot.docs.forEach(doc => {
            const data = doc.data();
            byIdentity.set(String(data.email || data.studentEmail || doc.id).trim().toLowerCase(), { ...data, uid: doc.id });
          });
          assignedSnapshot.docs.forEach(doc => {
            const data = doc.data();
            const identity = String(data.studentEmail || data.email || data.studentUid || doc.id).trim().toLowerCase();
            const joined = byIdentity.get(identity);
            byIdentity.set(identity, { ...data, ...joined, status: joined?.status || data.status || 'assignment-started',
              teacherRemark: joined?.teacherRemark || data.teacherRemark, uid: joined?.uid || data.studentUid || doc.id });
          });
          byIdentity.forEach(data => {
            const id = data.uid;
            if (!id) return;
            if (!students.has(id)) students.set(id, { id, name: data.name || 'Student', counts: { started: 0, progress: 0, submitted: 0, completed: 0 }, remarks: {} });
            const entry = students.get(id);
            entry.name = data.name || entry.name;
            const status = String(data.status || 'in-progress').trim().toLowerCase();
            if (status === 'assignment-started') entry.counts.started++;
            else if (status === 'submitted') entry.counts.submitted++;
            else if (status === 'completed') entry.counts.completed++;
            else entry.counts.progress++;
            if (data.teacherRemark) entry.remarks[assignment.id] = data.teacherRemark;
          });
        }
        body.innerHTML = '';
        if (!students.size) { body.innerHTML = '<tr><td colspan="6" class="p-3 text-slate-400">No students have joined your assignments yet.</td></tr>'; return; }
        [...students.values()].sort((a,b)=>a.name.localeCompare(b.name)).forEach(student => {
          const tr = document.createElement('tr'); tr.className = 'border-t border-slate-100';
          tr.innerHTML = '<td class="p-2 font-medium"></td><td class="p-2"></td><td class="p-2"></td><td class="p-2"></td><td class="p-2"></td><td class="p-2"><div class="flex gap-2"><input class="remark-input min-w-36 flex-1 border rounded px-2 py-1" maxlength="500" placeholder="Add remark"><button class="save-remark-btn bg-indigo-600 text-white px-2 py-1 rounded text-xs">Save</button></div></td>';
          tr.children[0].textContent = student.name;
          tr.children[1].textContent = student.counts.started;
          tr.children[2].textContent = student.counts.progress;
          tr.children[3].textContent = student.counts.submitted;
          tr.children[4].textContent = student.counts.completed;
          const input = tr.querySelector('.remark-input');
          input.value = Object.values(student.remarks)[0] || '';
          tr.querySelector('.save-remark-btn').addEventListener('click', async () => {
            const remark = input.value.trim();
            try {
              const studentRefs = studentRosterRefs.get(student.id) || [];
              await Promise.all(studentRefs.map(ref => ref.set({
                teacherRemark: remark,
                teacherRemarkUpdatedAt: firebase.firestore.FieldValue.serverTimestamp()
              }, { merge: true })));
              assignments.docs.forEach(assignment => invalidateTeacherRosterCache(assignment.id));
              showToast('Remark saved.', 'success');
            } catch (err) { showToast('Could not save remark: ' + err.message, 'error'); }
          });
          body.appendChild(tr);
        });
      } catch (err) {
        console.error('Student statistics failed:', err);
        body.innerHTML = '<tr><td colspan="6" class="p-3 text-rose-600">Could not load student statistics: ' + escapeHtml(err.message) + '</td></tr>';
      }
    }

async function loadAssignmentProgressCounts(assignment) {
      const assignmentRef = db.collection('assignments').doc(assignment.id);
      const [assignedSnapshot, joinedSnapshot] = await Promise.all([
        getTeacherRosterSnapshot(assignmentRef, 'assignedStudents'),
        getTeacherRosterSnapshot(assignmentRef, 'students')
      ]);

      // Merge assigned and joined records so a student is counted only once.
      const records = new Map();
      assignedSnapshot.docs.forEach(doc => {
        const data = doc.data();
        const key = String(data.studentEmail || data.email || data.studentUid || doc.id).trim().toLowerCase();
        records.set(key, { ...data, _key: key });
      });
      joinedSnapshot.docs.forEach(doc => {
        const data = doc.data();
        const key = String(data.email || data.studentEmail || data.uid || doc.id).trim().toLowerCase();
        const existing = records.get(key) || {};
        records.set(key, { ...existing, ...data, _key: key });
      });

      const assigned = Math.max(Number(assignment.assignedStudentCount || 0), records.size);
      const counts = { assignmentStarted: 0, inProgress: 0, submitted: 0, completed: 0 };
      records.forEach(record => {
        switch (String(record.status || 'assignment-started').trim().toLowerCase()) {
          case 'in-progress': counts.inProgress++; break;
          case 'submitted': counts.submitted++; break;
          case 'completed': counts.completed++; break;
          default: counts.assignmentStarted++; break;
        }
      });
      return { assigned, ...counts };
    }

    function renderTeacherAssignments() {
      if (!signedInUser || !db || accountRole !== 'teacher') return;
      if (teacherAssignmentsUnsubscribe) teacherAssignmentsUnsubscribe();
      const list = document.getElementById('teacherAssignmentsList');
      list.innerHTML = '<p class="text-sm text-slate-400">Loading assignments...</p>';
      teacherAssignmentsUnsubscribe = db.collection('assignments').where('teacherId', '==', signedInUser.uid)
        .onSnapshot(snapshot => {
          const docs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })).filter(isCurrentClass);
          docs.sort((a, b) => {
            const at = a.createdAt && a.createdAt.toDate ? a.createdAt.toDate().getTime() : 0;
            const bt = b.createdAt && b.createdAt.toDate ? b.createdAt.toDate().getTime() : 0;
            return bt - at;
          });
          list.innerHTML = '';
          if (!docs.length) {
            list.innerHTML = '<p class="text-sm text-slate-400">No assignments yet. Create one to get started.</p>';
            return;
          }
          scheduleTeacherStudentStatsRefresh();
        docs.forEach(item => {
            const card = document.createElement('button');
            card.type = 'button';
            card.className = 'text-left min-w-[920px] p-3 border border-slate-200 rounded-xl hover:border-indigo-400 hover:bg-indigo-50 transition flex items-center gap-4';
            const title = document.createElement('div');
            title.className = 'font-semibold text-slate-800 w-52 shrink-0 truncate';
            title.textContent = item.title || 'Untitled assignment';
            const meta = document.createElement('div');
            meta.className = 'text-xs text-slate-500 w-28 shrink-0';
            meta.textContent = 'Code: ' + (item.sessionCode || '—');
            const progress = document.createElement('div');
            progress.className = 'flex items-center gap-2 text-xs font-semibold whitespace-nowrap';
            const renderProgress = counts => {
              progress.innerHTML = '<span class="rounded-full bg-indigo-50 text-indigo-700 px-2.5 py-1">Assigned: ' + counts.assigned + '</span><span class="rounded-full bg-slate-100 text-slate-700 px-2.5 py-1">Started: ' + counts.assignmentStarted + '</span><span class="rounded-full bg-sky-50 text-sky-700 px-2.5 py-1">In progress: ' + counts.inProgress + '</span><span class="rounded-full bg-amber-50 text-amber-800 px-2.5 py-1">Submitted: ' + counts.submitted + '</span><span class="rounded-full bg-emerald-50 text-emerald-700 px-2.5 py-1">Completed: ' + counts.completed + '</span>';
            };
            renderProgress({ assigned: Number(item.assignedStudentCount || 0), assignmentStarted: 0, inProgress: 0, submitted: 0, completed: 0 });
            card.append(title, meta, progress);
            loadAssignmentProgressCounts(item).then(counts => {
              renderProgress(counts);
            }).catch(err => console.warn('Could not load assignment progress for ' + item.id, err));
            card.addEventListener('click', () => {
              currentAssignmentId = item.id; currentAssignmentData = item; currentSessionCode = item.sessionCode || '';
              loadTeacherAssignmentView(item.id);
            });
            const wrap = document.createElement('div');
            wrap.className = 'flex gap-2 items-stretch min-w-max';
            card.classList.add('flex-1');
            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'px-3 py-2 text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-xl hover:bg-rose-100';
            del.textContent = 'Delete';
            del.addEventListener('click', e => { e.stopPropagation(); deleteTeacherAssignment(item.id, item); });
            wrap.append(card, del);
            list.appendChild(wrap);
          });
        }, err => {
          console.error('Teacher assignments load failed:', err);
          list.innerHTML = '<p class="text-sm text-rose-600">Could not load assignments: ' + escapeHtml(err.message) + '</p>';
        });
    }

    function mergeCurrentTeacherRoster() {
      const joinedByEmail = new Map();
      currentJoinedStudents.forEach(student => { if (student.email) joinedByEmail.set(student.email.trim().toLowerCase(), student); });
      const roster = [];
      const assignedEmails = new Set();
      currentAssignedStudents.forEach(assigned => {
        const email = (assigned.studentEmail || '').toLowerCase();
        const joined = joinedByEmail.get(email);
        assignedEmails.add(email);
        roster.push({ ...assigned, ...joined, id: joined ? joined.id : assigned.id, studentUid: joined ? joined.id : null,
          studentEmail: email, assignedStudentKey: assigned.id,
          // When a student has joined, their live record is authoritative for submitted/completed status.
          status: joined?.status || assigned.status || 'assignment-started', isJoined: Boolean(joined) });
      });
      currentJoinedStudents.forEach(student => {
        const email = (student.email || '').toLowerCase();
        // Preserve the persisted Firestore status so submitted students retain review actions.
        if (!email || !assignedEmails.has(email)) roster.push({ ...student, studentUid: student.id, isJoined: true, status: student.status || 'in-progress' });
      });
      return roster;
    }

    function renderTeacherRoster() {
      renderStudentGrid(mergeCurrentTeacherRoster());
    }

    function updatePeerHelpToggleUI() {
      const button = document.getElementById('togglePeerHelpBtn');
      const state = document.getElementById('peerHelpToggleState');
      if (!button || !state) return;
      const active = isPeerHelpEnabled();
      button.setAttribute('aria-pressed', String(active));
      button.textContent = active ? 'Disable Peer Help' : 'Enable Peer Help';
      button.className = active
        ? 'bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-2 rounded-lg text-sm font-semibold'
        : 'bg-slate-600 hover:bg-slate-700 text-white px-3 py-2 rounded-lg text-sm font-semibold';
      state.textContent = active ? 'Peer Help enabled — students and teacher can help' : 'Teacher Help only — peer requests are disabled';
      state.className = active ? 'text-xs text-emerald-100' : 'text-xs text-indigo-200';
    }

    document.getElementById('togglePeerHelpBtn').addEventListener('click', async () => {
      if (!signedInUser || !db || currentUserRole !== 'teacher' || !currentAssignmentId
          || currentAssignmentData?.teacherId !== signedInUser.uid) {
        showToast('Open an assignment you own to change its help setting.', 'error');
        return;
      }
      const button = document.getElementById('togglePeerHelpBtn');
      const nextEnabled = !isPeerHelpEnabled();
      button.disabled = true;
      try {
        await db.collection('assignments').doc(currentAssignmentId).update({ peerHelpEnabled: nextEnabled });
        currentAssignmentData = { ...currentAssignmentData, peerHelpEnabled: nextEnabled };
        updatePeerHelpToggleUI();
        renderStudentGrid(mergeCurrentTeacherRoster());
        updatePeerHelpControls();
        if (currentUserRole === 'teacher') startTeacherHelpMonitor(currentAssignmentId);
        showToast(nextEnabled ? 'Peer Help enabled. Teacher Help remains available.' : 'Peer Help disabled. Students can still request teacher help.', 'success');
      } catch (err) {
        showToast('Could not change help setting: ' + err.message, 'error');
      } finally { button.disabled = false; }
    });

    function studentKeyForEmail(email) {
      return String(email || '').trim().toLowerCase().replace(/\//g, '_');
    }

    function renderStudentGrid(studentsList) {
      const grid = document.getElementById('studentsGrid');
      const countBadge = document.getElementById('studentCountBadge');
      
      countBadge.textContent = `${studentsList.length} Student${studentsList.length === 1 ? '' : 's'} Joined`;

      if (studentsList.length === 0) {
        stopStudentPreviewListeners();
        grid.innerHTML = `
          <div id="emptyStudentState" class="col-span-full text-center py-12 text-slate-400">
            <i class="fa-solid fa-user-clock text-4xl mb-3"></i>
            <p>Waiting for students to join with code <span class="font-bold text-indigo-600">${currentSessionCode}</span>...</p>
          </div>
        `;
        return;
      }

      grid.innerHTML = '';
      studentsList.forEach(student => {
        const card = document.createElement('div');
        card.className = "bg-slate-50 border border-slate-200 hover:border-indigo-400 p-4 rounded-xl shadow-sm transition flex flex-col gap-3";
        const displayName = student.name || student.studentEmail || 'Assigned student';
        const labels = { 'assignment-started': 'Assignment Started', 'in-progress': 'In Progress', 'submitted': 'Submitted', 'completed': 'Completed' };
        const isCompleted = String(student.status || '').trim().toLowerCase() === 'completed';
        // Inline colors keep the completed state distinct if utility CSS is overridden.
        const statusBadgeStyle = isCompleted
          ? 'background-color:#d1fae5;color:#047857;border:1px solid #a7f3d0;'
          : 'background-color:#eef2ff;color:#4338ca;border:1px solid #e0e7ff;';
        card.innerHTML = `
          <div class="flex justify-between items-start gap-2"><div class="min-w-0">
            <h5 class="font-bold text-slate-800 break-words">${escapeHtml(displayName)}</h5>
            <p class="text-xs text-slate-500 break-all">${escapeHtml(student.studentEmail || student.email || '')}</p>
            <span class="inline-block mt-1 text-xs rounded-full px-2 py-1" style="${statusBadgeStyle}">${labels[String(student.status || '').trim().toLowerCase()] || 'In Progress'}</span>
          </div><span class="bg-indigo-100 text-indigo-700 text-xs px-2 py-0.5 rounded font-semibold whitespace-nowrap">${currentAssignmentData?.slides?.length || 1} Slides</span></div>
          <div class="h-32 bg-white border border-slate-200 rounded flex items-center justify-center overflow-hidden relative">
            ${student.isJoined ? '<img id="thumb-' + escapeHtml(student.studentUid || student.id) + '" alt="Live student canvas preview" class="w-full h-full object-contain" />' : '<span class="text-xs text-slate-400">Not joined yet</span>'}
          </div>
          <div class="flex flex-wrap gap-2">
            ${student.isJoined ? '<button type="button" class="inspect-student-btn flex-1 bg-indigo-600 hover:bg-indigo-700 text-white text-xs px-3 py-2 rounded-lg font-semibold">View work</button>' : ''}
            ${student.status === 'submitted' ? '<button type="button" class="mark-completed-btn bg-emerald-600 hover:bg-emerald-700 text-white text-xs px-3 py-2 rounded-lg font-semibold">Completed</button><button type="button" class="amendments-btn bg-amber-500 hover:bg-amber-600 text-white text-xs px-3 py-2 rounded-lg font-semibold">Amendments Needed</button>' : ''}
            ${student.isJoined && ['assignment-started', 'in-progress'].includes(String(student.status || '').trim().toLowerCase()) ? '<button type="button" class="force-completed-btn bg-emerald-600 hover:bg-emerald-700 text-white text-xs px-3 py-2 rounded-lg font-semibold">Complete Assignment</button>' : ''}
          </div>`;
        // Open a joined student's canvas when any non-action area of their card is clicked.
        // Keep action buttons independent so review/status controls never trigger navigation.
        card.classList.add('cursor-pointer');
        card.setAttribute('role', 'button');
        card.setAttribute('tabindex', '0');
        card.setAttribute('aria-label', `View work for ${displayName}`);
        const openThisStudentWork = () => {
          if (student.isJoined) openWorkspaceForInspection(student.studentUid || student.id, displayName, student.status, student);
        };
        card.addEventListener('click', event => {
          if (event.target.closest('button, a, input, select, textarea, label')) return;
          openThisStudentWork();
        });
        card.addEventListener('keydown', event => {
          if ((event.key === 'Enter' || event.key === ' ') && !event.target.closest('button, a, input, select, textarea, label')) {
            event.preventDefault();
            openThisStudentWork();
          }
        });
        const inspect = card.querySelector('.inspect-student-btn');
        if (inspect) inspect.addEventListener('click', e => { e.stopPropagation(); openThisStudentWork(); });
        const completed = card.querySelector('.mark-completed-btn');
        if (completed) completed.addEventListener('click', e => { e.stopPropagation(); setStudentReviewStatus(student, 'completed'); });
        const amendments = card.querySelector('.amendments-btn');
        if (amendments) amendments.addEventListener('click', e => { e.stopPropagation(); setStudentReviewStatus(student, 'in-progress'); });
        const forceCompleted = card.querySelector('.force-completed-btn');
        if (forceCompleted) forceCompleted.addEventListener('click', async e => {
          e.stopPropagation();
          if (!window.confirm('Mark ' + displayName + '\'s assignment as Completed without student submission?')) return;
          forceCompleted.disabled = true;
          try { await setStudentReviewStatus(student, 'completed'); }
          finally { forceCompleted.disabled = false; }
        });
        grid.appendChild(card);
      });
      syncStudentPreviewListeners(studentsList);
    }

    // Keep one live preview listener per joined student while the teacher roster is visible.
    // Reuse existing listeners across roster rerenders and unsubscribe removed students.
    function syncStudentPreviewListeners(studentsList) {
      const activeKeys = new Set();
      if (!currentAssignmentId || !db || teacherDashboard.classList.contains('hidden')) {
        stopStudentPreviewListeners();
        return;
      }
      studentsList.forEach(student => {
        if (!student.isJoined) return;
        const studentUid = student.studentUid || student.id;
        if (!studentUid) return;
        const key = `${currentAssignmentId}:${studentUid}`;
        activeKeys.add(key);
        const img = document.getElementById(`thumb-${studentUid}`);
        // Roster rerenders replace image elements; reuse the last live or archived preview.
        const cachedPreviewSource = studentPreviewData.get(key);
        if (img && cachedPreviewSource && img.getAttribute('src') !== cachedPreviewSource) img.src = cachedPreviewSource;
        if (studentPreviewUnsubscribers.has(key)) return;
        const unsubscribe = db.collection('assignments').doc(currentAssignmentId)
          .collection('students').doc(studentUid).collection('slides').doc('slide_0')
          .onSnapshot(async slideDoc => {
            const version = (studentPreviewVersions.get(key) || 0) + 1;
            studentPreviewVersions.set(key, version);
            const slideData = slideDoc.exists ? (slideDoc.data() || {}) : {};
            let previewSource = slideData.canvasData || null;

            // Submitted canvases move to Storage and canvasData is removed from Firestore.
            // Resolve the archived image URL so the dashboard thumbnail remains visible.
            if (!previewSource && slideData.canvasStoragePath && storage) {
              try {
                previewSource = await storage.ref(slideData.canvasStoragePath).getDownloadURL();
              } catch (err) {
                console.warn('Could not load archived student preview:', err);
              }
            }

            // Ignore a slow Storage URL lookup if a newer live canvas snapshot arrived.
            if (studentPreviewVersions.get(key) !== version) return;
            if (previewSource) studentPreviewData.set(key, previewSource);
            else studentPreviewData.delete(key);

            const previewImg = document.getElementById(`thumb-${studentUid}`);
            if (!previewImg) return;
            if (previewSource) {
              if (previewImg.getAttribute('src') !== previewSource) previewImg.src = previewSource;
            } else {
              previewImg.removeAttribute('src');
            }
          }, err => console.warn('Student preview listener:', err));
        studentPreviewUnsubscribers.set(key, unsubscribe);
      });
      studentPreviewUnsubscribers.forEach((unsubscribe, key) => {
        if (!activeKeys.has(key)) {
          unsubscribe();
          studentPreviewUnsubscribers.delete(key);
          studentPreviewData.delete(key);
        }
      });
    }

    function stopStudentPreviewListeners() {
      studentPreviewUnsubscribers.forEach(unsubscribe => unsubscribe());
      studentPreviewUnsubscribers.clear();
    }

    // Statistics aggregate every assignment roster, so refresh only while the panel is visible.
    // This avoids repeated collection reads in the background when students' work changes.
    function scheduleTeacherStudentStatsRefresh() {
      const panel = document.getElementById('teacherStudentStatsPanel');
      if (!panel || panel.classList.contains('hidden')) return;
      if (teacherStatsRefreshTimer) clearTimeout(teacherStatsRefreshTimer);
      teacherStatsRefreshTimer = setTimeout(() => {
        teacherStatsRefreshTimer = null;
        if (!panel.classList.contains('hidden')) loadTeacherStudentStats();
      }, 1500);
    }

    async function setStudentReviewStatus(student, status) {
      if (!currentAssignmentId || !signedInUser || !db) return;
      try {
        const update = { status, classId: currentAssignmentData?.classId || currentClassId,
          reviewedAt: firebase.firestore.FieldValue.serverTimestamp(),
          reviewOutcome: status === 'completed' ? 'completed' : 'amendments-needed' };
        const writes = [];
        if (student.assignedStudentKey) {
          writes.push(db.collection('assignments').doc(currentAssignmentId).collection('assignedStudents').doc(student.assignedStudentKey).set(update, { merge: true }));
        }
        if (student.studentUid) {
          writes.push(db.collection('users').doc(student.studentUid).collection('submissions').doc(currentAssignmentId).set(update, { merge: true }));
          writes.push(db.collection('assignments').doc(currentAssignmentId).collection('students').doc(student.studentUid).set(update, { merge: true }));
        }
        if (!writes.length) throw new Error('Could not identify the student records to update.');
        await Promise.all(writes);
        showToast(status === 'completed' ? 'Assignment marked completed by teacher.' : 'Amendments requested. Student can continue editing.', 'success');
      } catch (err) {
        console.error('Could not update review status:', err);
        showToast('Could not update review status: ' + err.message, 'error');
      }
    }

    function openWorkspaceForInspection(stId, stName, status = 'submitted', studentRecord = null) {
      // Remember where the teacher was on the dashboard so Back to Dashboard restores that view.
      teacherDashboardScrollY = window.scrollY || document.documentElement.scrollTop || 0;
      // Live roster previews are unnecessary while inspecting one student's full canvas.
      stopStudentPreviewListeners();
      inspectingStudentId = stId;
      saveStepScreenState();
      currentSubmissionStatus = status || 'submitted';
      // Teacher feedback should be visually distinct from the student's own writing.
      currentColor = '#dc2626';
      const annotationColorPicker = document.getElementById('colorPicker');
      if (annotationColorPicker) annotationColorPicker.value = currentColor;
      setTool('pen');
      window.currentInspectedStudentRecord = studentRecord || { studentUid: stId, id: stId, status: currentSubmissionStatus };
      updatePeerHelpControls();
      teacherDashboard.classList.add('hidden');
      workspaceScreen.classList.remove('hidden');

      document.getElementById('exitWorkspaceBtn').classList.remove('hidden');
      document.getElementById('workspaceTitle').textContent = `Inspecting: ${stName}`;
      document.getElementById('workspaceSubtext').textContent = "Teacher annotations live-sync to the student's canvas";
      document.getElementById('teacherReviewActions').classList.toggle('hidden', currentSubmissionStatus !== 'submitted');
      updateSubmitAssignmentButton();

      currentSlideIndex = 0;
      setupSlideWorkspace();
      // Reassert teacher feedback defaults after workspace setup refreshes controls.
      currentColor = '#dc2626';
      if (annotationColorPicker) annotationColorPicker.value = currentColor;
      setTool('pen');
      updatePeerHelpControls();
    }

    // Pre-fill the session code immediately when a student opens a shared link.
    const initialJoinCode = new URLSearchParams(window.location.search).get('join');
    if (initialJoinCode) document.getElementById('joinCodeInput').value = initialJoinCode.trim().toUpperCase();

    // Reopen an assignment from its shared link if this account has already joined it.
    // This avoids showing the join-code/name form and avoids rewriting membership/submission data.
    async function openJoinedAssignmentFromLink(inputCode) {
      if (!signedInUser || !db || !inputCode) return false;
      const lookupDoc = await db.collection('assignmentLookups').doc(inputCode).get();
      if (!lookupDoc.exists) return false;
      const lookup = lookupDoc.data() || {};
      if ((lookup.classId || 'MB1') !== currentClassId) {
        showToast('This assignment belongs to class ' + (lookup.classId || 'MB1') + '. Switch to that class before opening it.', 'error');
        return true;
      }
      const assignmentId = lookup.assignmentId;
      if (!assignmentId) return false;

      const assignmentRef = db.collection('assignments').doc(assignmentId);
      const membershipRef = assignmentRef.collection('students').doc(signedInUser.uid);
      const membershipDoc = await membershipRef.get();
      if (!membershipDoc.exists) return false;

      const assignmentDoc = await assignmentRef.get();
      if (!assignmentDoc.exists) {
        showToast('This assignment is no longer available.', 'error');
        return true;
      }
      const membership = membershipDoc.data() || {};
      const assignment = assignmentDoc.data() || {};
      const assignedKey = studentKeyForEmail(signedInUser.email);
      const assignedRef = assignmentRef.collection('assignedStudents').doc(assignedKey);
      const assignedDoc = await assignedRef.get();
      const assignedStatus = assignedDoc.exists ? (assignedDoc.data().status || 'assignment-started') : (membership.status || 'in-progress');

      await switchRole('student');
      studentId = signedInUser.uid;
      studentName = membership.name || studentProfileName || signedInUser.displayName || (signedInUser.email || 'Student').split('@')[0];
      currentAssignmentId = assignmentId;
      currentAssignmentData = assignment;
      currentSessionCode = inputCode;
      saveStepScreenState();
      currentAssignedStudentKey = assignedDoc.exists ? assignedKey : null;
      currentSubmissionStatus = assignedStatus === 'assignment-started' ? 'in-progress' : assignedStatus;
      window.currentStudentHelpRequested = Boolean(membership.helpRequested);
      window.currentStudentHelpQuestion = membership.helpQuestion || '';
      updateSubmitAssignmentButton();

      studentJoinScreen.classList.add('hidden');
      studentHistoryScreen.classList.add('hidden');
      teacherDashboard.classList.add('hidden');
      workspaceScreen.classList.remove('hidden');
      const exitButton = document.getElementById('exitWorkspaceBtn');
      exitButton.classList.remove('hidden');
      exitButton.innerHTML = '<i class="fa-solid fa-arrow-left"></i> Back to Dashboard';
      document.getElementById('workspaceTitle').textContent = assignment.title || 'Interactive Assignment';
      document.getElementById('workspaceSubtext').textContent = `Student: ${studentName} (Stylus & Touch Active)`;
      currentSlideIndex = 0;
      setupSlideWorkspace();
      return true;
    }

    // ==========================================
    // STUDENT JOIN & MATCHING
    // ==========================================
    document.getElementById('studentJoinForm').addEventListener('submit', async (e) => {
      e.preventDefault();

      const inputCode = document.getElementById('joinCodeInput').value.trim().toUpperCase();
      let name = document.getElementById('studentNameInput').value.trim();
      const joinBtn = document.getElementById('joinBtn');

      if (!signedInUser) {
        showToast("Sign in with Google before joining an assignment.", "error");
        return;
      }
      if (!inputCode || !name) {
        showToast("Please provide both code and student name", "error");
        return;
      }
      // A saved canonical name is authoritative even if the UI state was stale.
      if (studentProfileName) name = studentProfileName;

      joinBtn.disabled = true;
      joinBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Joining...`;

      let matchedData = null;
      let matchedDocId = null;

      studentName = name;
      studentId = signedInUser.uid;

      try {
        if (!db) throw new Error('Firebase is not available. Check your connection.');

        // Resolve the session code without reading or querying assignment contents.
        const lookupDoc = await db.collection('assignmentLookups').doc(inputCode).get();
        if (!lookupDoc.exists) {
          throw new Error('Session code not found. Verify the code with your teacher.');
        }

        const lookup = lookupDoc.data();
        if ((lookup.classId || 'MB1') !== currentClassId) {
          throw new Error('This session code belongs to class ' + (lookup.classId || 'MB1') + '. Select that class before joining.');
        }
        matchedDocId = lookup.assignmentId;
        if (!matchedDocId) throw new Error('This session code is not configured correctly.');

        const now = firebase.firestore.FieldValue.serverTimestamp();

        // Atomically set the student's name only if this account has not chosen one before.
        // Existing names always win, so one Google account cannot use different names across assignments.
        const userRef = db.collection('users').doc(signedInUser.uid);
        const peerRef = db.collection('peerDirectory').doc(signedInUser.uid);
        const canonicalName = await db.runTransaction(async transaction => {
          const userSnapshot = await transaction.get(userRef);
          const peerSnapshot = await transaction.get(peerRef);
          const profileData = userSnapshot.exists ? userSnapshot.data() : {};
          const savedName = typeof profileData.studentName === 'string' ? profileData.studentName.trim() : '';
          const chosenName = savedName || name;

          if (!savedName) {
            transaction.set(userRef, { studentName: chosenName, studentNameSetAt: now }, { merge: true });
          }
          // The directory stores only the student's chosen display name, not email or other profile data.
          transaction.set(peerRef, {
            studentName: chosenName,
            nameSource: 'chosen',
            updatedAt: now
          }, { merge: true });
          return chosenName;
        });
        name = canonicalName;
        studentProfileName = canonicalName;
        studentName = canonicalName;
        const canonicalNameInput = document.getElementById('studentNameInput');
        canonicalNameInput.value = canonicalName;
        canonicalNameInput.readOnly = true;
        canonicalNameInput.title = 'This name is saved to your account and is used for every assignment.';

        // Firestore rules validate that the code maps to this assignment before membership is created.
        const joinedStudentRef = db.collection('assignments').doc(matchedDocId).collection('students').doc(studentId);
        await joinedStudentRef.set({
            uid: studentId,
            name: studentName,
            status: 'in-progress',
            email: signedInUser.email || '',
            sessionCode: inputCode,
            joinedAt: now,
            lastWorkedAt: now
          }, { merge: true });
        const joinedStudentDoc = await joinedStudentRef.get();
        window.currentStudentHelpRequested = Boolean(joinedStudentDoc.exists && joinedStudentDoc.data().helpRequested);
        window.currentStudentHelpQuestion = joinedStudentDoc.exists ? (joinedStudentDoc.data().helpQuestion || '') : '';

        // Assignment content is readable only after the student's membership exists.
        const assignmentDoc = await db.collection('assignments').doc(matchedDocId).get();
        if (!assignmentDoc.exists) throw new Error('The assignment is no longer available.');
        matchedData = assignmentDoc.data();

        const assignedStudentRef = db.collection('assignments').doc(matchedDocId).collection('assignedStudents').doc(studentKeyForEmail(signedInUser.email));
        const assignedStudentDoc = await assignedStudentRef.get();
        const assignedStatus = assignedStudentDoc.exists ? (assignedStudentDoc.data().status || 'assignment-started') : 'in-progress';
        currentAssignedStudentKey = assignedStudentDoc.exists ? studentKeyForEmail(signedInUser.email) : null;
        currentSubmissionStatus = assignedStatus === 'assignment-started' ? 'in-progress' : assignedStatus;
        if (assignedStudentDoc.exists && assignedStatus === 'assignment-started') {
          await assignedStudentRef.update({ status: 'in-progress', startedAt: now, lastWorkedAt: now });
        }
        const submissionRef = db.collection('users').doc(studentId).collection('submissions').doc(matchedDocId);
        const existingSubmission = await submissionRef.get();
        if (!existingSubmission.exists) {
          await submissionRef.set({ assignmentId: matchedDocId, classId: matchedData.classId || currentClassId, title: matchedData.title || lookup.title || 'Assignment',
            description: matchedData.description || '', sessionCode: inputCode, status: currentSubmissionStatus,
            startedAt: now, lastWorkedAt: now, slideCount: (matchedData.slides || []).length });
        } else if (currentSubmissionStatus !== 'completed') {
          await submissionRef.set({ assignmentId: matchedDocId, classId: matchedData.classId || currentClassId, title: matchedData.title || lookup.title || 'Assignment',
            description: matchedData.description || '', sessionCode: inputCode, status: currentSubmissionStatus,
            lastWorkedAt: now, slideCount: (matchedData.slides || []).length }, { merge: true });
        }
      } catch (err) {
        console.error('Could not join assignment:', err);
        showToast('Could not join assignment: ' + err.message, 'error');
        joinBtn.disabled = false;
        joinBtn.innerHTML = '<span>Start Working</span> <i class="fa-solid fa-arrow-right"></i>';
        return;
      }

      currentAssignmentData = matchedData;
      currentAssignmentId = matchedDocId;
      currentSessionCode = inputCode;
      saveStepScreenState();
      updateSubmitAssignmentButton();

      studentJoinScreen.classList.add('hidden');
      studentHistoryScreen.classList.add('hidden');
      workspaceScreen.classList.remove('hidden');
      const exitButton = document.getElementById('exitWorkspaceBtn');
      exitButton.classList.remove('hidden');
      exitButton.innerHTML = '<i class="fa-solid fa-arrow-left"></i> Back to Dashboard';
      document.getElementById('workspaceTitle').textContent = currentAssignmentData.title || "Interactive Assignment";
      document.getElementById('workspaceSubtext').textContent = `Student: ${studentName} (Stylus & Touch Active)`;

      currentSlideIndex = 0;
      setupSlideWorkspace();
      showToast("Joined assignment successfully!", "success");

      joinBtn.disabled = false;
      joinBtn.innerHTML = `<span>Start Working</span> <i class="fa-solid fa-arrow-right"></i>`;
    });

    // ==========================================
    // STUDENT HISTORY / ASSIGNMENT STATUS
    // ==========================================
    function renderStudentHistory() {
      if (!signedInUser || !db) return;
      if (historyUnsubscribe) historyUnsubscribe();
      if (assignedHistoryUnsubscribe) assignedHistoryUnsubscribe();
      const list = document.getElementById('studentHistoryList');
      list.innerHTML = '<div class="col-span-full text-center py-8 text-slate-400">Loading assignments...</div>';
      studentAssignedRecords = [];
      studentSubmissionRecords = [];
      historyUnsubscribe = db.collection('users').doc(signedInUser.uid).collection('submissions').onSnapshot(snapshot => {
        studentSubmissionRecords = snapshot.docs.map(doc => ({ id: doc.id, assignmentId: doc.id, ...doc.data() }));
        renderCombinedStudentHistory();
      }, err => {
        console.error('History load failed:', err);
        list.innerHTML = '<div class="col-span-full text-center py-8 text-rose-600">Could not load saved work: ' + escapeHtml(err.message) + '</div>';
      });
      // Session-code access replaces email-based assignment targeting. History is built
      // from this signed-in student's own submissions, avoiding a collection-group query.
      studentAssignedRecords = [];
    }

    function renderCombinedStudentHistory() {
      const list = document.getElementById('studentHistoryList');
      const byAssignment = new Map();
      studentSubmissionRecords.filter(isCurrentClass).forEach(item => byAssignment.set(item.assignmentId || item.id, { ...item, assignmentId: item.assignmentId || item.id }));
      studentAssignedRecords.forEach(item => {
        if (!item.assignmentId) return;
        const prior = byAssignment.get(item.assignmentId) || {};
        byAssignment.set(item.assignmentId, { ...prior, ...item, id: item.assignmentId, assignmentId: item.assignmentId,
          status: item.status || prior.status || 'assignment-started', assignedStudentKey: item.assignedStudentKey || item.id, source: 'assigned' });
      });
      const items = [...byAssignment.values()];
      items.sort((a,b) => {
        const date = x => x.lastWorkedAt?.toDate ? x.lastWorkedAt.toDate().getTime() : (x.assignedAt?.toDate ? x.assignedAt.toDate().getTime() : 0);
        return date(b) - date(a);
      });
      document.getElementById('historyStartedCount').textContent = items.filter(x => x.status === 'assignment-started').length;
      document.getElementById('historyProgressCount').textContent = items.filter(x => x.status === 'in-progress').length;
      document.getElementById('historySubmittedCount').textContent = items.filter(x => x.status === 'submitted').length;
      document.getElementById('historyCompletedCount').textContent = items.filter(x => x.status === 'completed').length;
      if (!items.length) {
        list.innerHTML = '<div class="col-span-full text-center py-12 text-slate-400 bg-white rounded-xl border border-slate-200"><i class="fa-solid fa-folder-open text-3xl mb-3"></i><p>No assignments assigned yet. Ask your teacher to assign work to your Google email.</p></div>';
        return;
      }
      list.innerHTML = '';
      const labels = { 'assignment-started':'Assignment Started', 'in-progress':'In Progress', 'submitted':'Submitted', 'completed':'Completed' };
      items.forEach(item => {
        const card = document.createElement('article');
        card.className = 'bg-white border border-slate-200 rounded-xl p-5 shadow-sm flex flex-col gap-3';
        const dateValue = item.lastWorkedAt || item.assignedAt;
        const date = dateValue && dateValue.toDate ? dateValue.toDate().toLocaleString() : 'Recently assigned';
        const status = item.status || 'in-progress';
        const buttonLabel = status === 'assignment-started' ? 'Start assignment' : status === 'submitted' ? 'View submitted work' : status === 'completed' ? 'View completed work' : 'Continue work';
        card.innerHTML = '<div class="flex items-start justify-between gap-3"><div class="min-w-0"><h3 class="font-bold text-slate-800 break-words"></h3><p class="text-sm text-slate-500 mt-1"></p></div><span class="text-xs rounded-full px-2 py-1 bg-slate-100 text-slate-700 whitespace-nowrap"></span></div><div class="text-xs text-slate-400"></div><button class="reopen-work-btn w-full bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg py-2.5 font-semibold"></button><button type="button" class="delete-own-assignment-btn w-full bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 rounded-lg py-2 font-semibold">Delete from my work</button>';
        card.querySelector('h3').textContent = item.title || 'Untitled assignment';
        card.querySelector('p').textContent = (item.slideCount || 1) + ' slides' + (item.classLabel ? ' • ' + item.classLabel : '');
        card.querySelector('span').textContent = labels[status] || 'In Progress';
        card.querySelector('.text-xs.text-slate-400').textContent = 'Last updated: ' + date;
        card.querySelector('button').textContent = buttonLabel;
        card.querySelector('.reopen-work-btn').addEventListener('click', () => status === 'assignment-started' ? startAssignedAssignment(item) : reopenSavedAssignment(item.assignmentId || item.id, item));
        card.querySelector('.delete-own-assignment-btn').addEventListener('click', () => deleteStudentAssignment(item.assignmentId || item.id, item.title || 'this assignment'));
        list.appendChild(card);
      });
    }

    function startAssignedAssignment(item) {
      if (!item.sessionCode) return showToast('This assignment has no session code. Ask your teacher for help.', 'error');
      document.getElementById('joinCodeInput').value = item.sessionCode;
      document.getElementById('studentNameInput').value = studentProfileName || signedInUser.displayName || (signedInUser.email || 'Student').split('@')[0];
      document.getElementById('studentNameInput').readOnly = Boolean(studentProfileName);
      studentHistoryScreen.classList.add('hidden');
      studentJoinScreen.classList.remove('hidden');
      document.getElementById('studentJoinForm').requestSubmit();
    }

    function updateSubmitAssignmentButton() {
      const button = document.getElementById('submitAssignmentBtn');
      if (!button) return;
      const isStudent = currentUserRole === 'student' && !inspectingStudentId;
      button.classList.toggle('hidden', !isStudent || currentSubmissionStatus !== 'in-progress');
      button.disabled = false;
      button.textContent = 'Submit assignment';
      const ask = document.getElementById('askForHelpBtn');
      if (ask) ask.classList.toggle('hidden', !isStudent || currentSubmissionStatus !== 'in-progress');
    }

    document.getElementById('teacherMarkCompletedBtn').addEventListener('click', async () => {
      const record = window.currentInspectedStudentRecord;
      if (!record) return;
      try {
        // Teacher annotations may have created a fresh Firestore canvas image after submission.
        // Archive that final reviewed version too, before marking the work completed.
        await flushCanvasSaveToFirestore();
        await archiveStudentCanvasToStorage(currentAssignmentId, record.studentUid || inspectingStudentId);
        await setStudentReviewStatus(record, 'completed');
        currentSubmissionStatus = 'completed';
        document.getElementById('teacherReviewActions').classList.add('hidden');
        document.getElementById('workspaceSubtext').textContent = "Completed • Teacher annotations remain visible to the student";
      } catch (err) {
        console.error('Could not archive reviewed canvas:', err);
        showToast('Could not archive the reviewed canvas. The work has not been marked completed.', 'error');
      }
    });

    document.getElementById('teacherRequestAmendmentsBtn').addEventListener('click', async () => {
      const record = window.currentInspectedStudentRecord;
      if (!record) return;
      await setStudentReviewStatus(record, 'in-progress');
      currentSubmissionStatus = 'in-progress';
      document.getElementById('teacherReviewActions').classList.add('hidden');
      document.getElementById('workspaceSubtext').textContent = "Amendments requested • Teacher annotations live-sync to the student";
    });

    // Archive a student's completed canvas snapshots in Cloud Storage, then remove the
    // large data URL from Firestore. The live canvas still uses Firestore while in progress.
    async function archiveStudentCanvasToStorage(assignmentId, studentUid) {
      if (!storage || !db || !assignmentId || !studentUid) {
        throw new Error('Firebase Storage is not initialized.');
      }
      const slidesRef = db.collection('assignments').doc(assignmentId)
        .collection('students').doc(studentUid).collection('slides');
      const snapshot = await slidesRef.get();
      for (const slideDoc of snapshot.docs) {
        const slideData = slideDoc.data() || {};
        if (!slideData.canvasData) continue;
        const dataUrl = slideData.canvasData;
        if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
          console.warn('Skipping unsupported canvas image format for', slideDoc.id);
          continue;
        }
        const storagePath = `student-work/${assignmentId}/${studentUid}/${slideDoc.id}.jpg`;
        const fileRef = storage.ref(storagePath);
        await fileRef.putString(dataUrl, 'data_url', {
          contentType: dataUrl.startsWith('data:image/png') ? 'image/png' : 'image/jpeg',
          cacheControl: 'private, max-age=0, no-cache'
        });
        // Only clear the Firestore image after the upload succeeds.
        await slideDoc.ref.update({
          canvasStoragePath: storagePath,
          canvasData: firebase.firestore.FieldValue.delete(),
          archivedAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      }
    }

    document.getElementById('submitAssignmentBtn').addEventListener('click', async () => {
      if (!signedInUser || !currentAssignmentId || currentSubmissionStatus !== 'in-progress') return;
      const button = document.getElementById('submitAssignmentBtn');
      button.disabled = true;
      try {
        // Flush any pending two-second canvas save before archiving the submission.
        await flushCanvasSaveToFirestore();
        await archiveStudentCanvasToStorage(currentAssignmentId, signedInUser.uid);
        const now = firebase.firestore.FieldValue.serverTimestamp();
        await db.collection('users').doc(signedInUser.uid).collection('submissions').doc(currentAssignmentId).set({
          assignmentId: currentAssignmentId, classId: currentAssignmentData?.classId || currentClassId,
          title: currentAssignmentData?.title || 'Assignment',
          status: 'submitted', submittedAt: now, lastWorkedAt: now
        }, { merge: true });
        await db.collection('assignments').doc(currentAssignmentId).collection('students').doc(signedInUser.uid).set({
          uid: signedInUser.uid, name: studentName || signedInUser.displayName || 'Student',
          status: 'submitted', submittedAt: now, lastWorkedAt: now
        }, { merge: true });
        if (currentAssignedStudentKey) {
          await db.collection('assignments').doc(currentAssignmentId).collection('assignedStudents').doc(currentAssignedStudentKey)
            .update({ status: 'submitted', submittedAt: now, lastWorkedAt: now });
        }
        currentSubmissionStatus = 'submitted';
        updateSubmitAssignmentButton();
        // Keep navigation available after submission; students return to My Past Work.
        const exitButton = document.getElementById('exitWorkspaceBtn');
        exitButton.classList.remove('hidden');
        exitButton.innerHTML = '<i class="fa-solid fa-arrow-left"></i> Back to Dashboard';
        renderCombinedStudentHistory();
        showToast('Assignment submitted to your teacher for review.', 'success');
      } catch (err) {
        console.error('Assignment submission failed:', err);
        showToast('Could not submit assignment: ' + err.message, 'error');
      } finally { button.disabled = false; }
    });

    async function reopenSavedAssignment(assignmentId, submission) {
      if (!signedInUser) return showToast('Sign in first.', 'error');
      try {
        const doc = await db.collection('assignments').doc(assignmentId).get();
        if (!doc.exists) {
          showToast('This assignment is no longer available.', 'error');
          return;
        }
        const savedAssignmentData = doc.data();
        if (!isCurrentClass(savedAssignmentData)) {
          showToast('This saved assignment belongs to class ' + (savedAssignmentData.classId || 'MB1') + '. Switch classes to open it.', 'error');
          return;
        }
        currentAssignmentData = savedAssignmentData;
        currentAssignmentId = assignmentId;
        currentSessionCode = currentAssignmentData.sessionCode || submission.sessionCode || '';
        saveStepScreenState();
        studentId = signedInUser.uid;
        studentName = studentProfileName || signedInUser.displayName || 'Student';
        inspectingStudentId = null;
        currentSubmissionStatus = submission.status || 'in-progress';
        currentAssignedStudentKey = submission.assignedStudentKey || null;
        currentUserRole = 'student';
        studentHistoryScreen.classList.add('hidden');
        studentJoinScreen.classList.add('hidden');
        roleSelectionScreen.classList.add('hidden');
        workspaceScreen.classList.remove('hidden');
        document.getElementById('exitWorkspaceBtn').classList.remove('hidden');
        document.getElementById('exitWorkspaceBtn').innerHTML = '<i class="fa-solid fa-arrow-left"></i> Back to Dashboard';
        document.getElementById('workspaceTitle').textContent = currentAssignmentData.title || 'Assignment';
        document.getElementById('workspaceSubtext').textContent = currentSubmissionStatus === 'submitted'
          ? 'Submitted for teacher review • Read-only'
          : currentSubmissionStatus === 'completed' ? 'Completed • Read-only' : 'Your saved work • Auto-saves to your account';
        updateSubmitAssignmentButton();
        currentSlideIndex = 0;
        setupSlideWorkspace();
      } catch (err) {
        console.error('Reopen failed:', err);
        showToast('Could not reopen assignment: ' + err.message, 'error');
      }
    }

    document.getElementById('exitWorkspaceBtn').addEventListener('click', () => {
      if (unsubSlideWork) { unsubSlideWork(); unsubSlideWork = null; }
      workspaceScreen.classList.add('hidden');
      if (inspectingStudentId) {
        teacherDashboard.classList.remove('hidden');
        inspectingStudentId = null;
        // Restore the dashboard at its previous scroll position; do not reload/reset its active view.
        requestAnimationFrame(() => window.scrollTo(0, teacherDashboardScrollY));
      } else if (currentUserRole === 'student') {
        studentHistoryScreen.classList.remove('hidden');
        document.getElementById('exitWorkspaceBtn').innerHTML = '<i class="fa-solid fa-arrow-left"></i> Back to Dashboard';
      } else {
        teacherDashboard.classList.remove('hidden');
      }
      saveStepScreenState();
      // Keep the teacher's existing dashboard/assignment view in place. Reloading it here
      // resets the view and causes avoidable Firestore reads.
    });

    // ==========================================
    // STYLUS & TOUCH SUPPORT / CANVAS WORKSPACE
    // ==========================================
    function setupSlideWorkspace() {
      undoStack = [];
      redoStack = [];
      syncDrawingPreferencesToControls();
      updateHistoryButtons();
      updateSlideNavigationUI();
      resizeCanvas();
      updatePeerHelpControls();
      loadCurrentSlideData();
      startPeerHelpListeners();
    }

    function updateSlideNavigationUI() {
      const totalSlides = currentAssignmentData?.slides?.length || 1;
      document.getElementById('slideIndicator').textContent = `Page ${currentSlideIndex + 1} of ${totalSlides}`;
      document.getElementById('prevSlideBtn').disabled = (currentSlideIndex === 0);
      document.getElementById('nextSlideBtn').disabled = (currentSlideIndex === totalSlides - 1);

      const slideConfig = currentAssignmentData?.slides?.[currentSlideIndex];
      const promptContainer = document.getElementById('slidePromptContainer');
      const promptText = document.getElementById('slidePromptText');
      const currentSlidePrompt = slideConfig?.prompt;
      if (currentSlidePrompt) {
        promptText.textContent = currentSlidePrompt;
        promptContainer.classList.remove('hidden');
      } else {
        promptContainer.classList.add('hidden');
      }

      // Display question images above the writing canvas, preserving their aspect ratio.
      // Older assignments stored uploaded data images in bgUrl; support those without
      // continuing to render them as a canvas background.
      const questionImageContainer = document.getElementById('questionImageContainer');
      const questionImageDisplay = document.getElementById('questionImageDisplay');
      const legacyImageUrl = typeof slideConfig?.bgUrl === 'string' && slideConfig.bgUrl.startsWith('data:image/')
        ? slideConfig.bgUrl : '';
      const questionImageUrl = slideConfig?.questionImage || legacyImageUrl;
      if (questionImageUrl) {
        questionImageDisplay.src = questionImageUrl;
        questionImageContainer.classList.remove('hidden');
      } else {
        questionImageDisplay.removeAttribute('src');
        questionImageContainer.classList.add('hidden');
      }
    }

    document.getElementById('prevSlideBtn').addEventListener('click', async () => {
      if (currentSlideIndex > 0) {
        await flushCanvasSaveToFirestore();
        currentSlideIndex--;
        setupSlideWorkspace();
      }
    });

    document.getElementById('nextSlideBtn').addEventListener('click', async () => {
      const totalSlides = currentAssignmentData?.slides?.length || 1;
      if (currentSlideIndex < totalSlides - 1) {
        await flushCanvasSaveToFirestore();
        currentSlideIndex++;
        setupSlideWorkspace();
      }
    });

    function resizeCanvas() {
      const rect = canvasWrapper.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      
      // Save current canvas content in memory buffer before resizing
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = mainCanvas.width;
      tempCanvas.height = mainCanvas.height;
      const tempCtx = tempCanvas.getContext('2d');
      tempCtx.drawImage(mainCanvas, 0, 0);

      // Use a higher-resolution backing canvas so camera photos and handwriting
      // remain legible on high-density phone screens. Pointer coordinates already
      // scale from CSS pixels to the canvas's internal pixel dimensions.
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      mainCanvas.width = Math.round(rect.width * pixelRatio);
      mainCanvas.height = Math.round(rect.height * pixelRatio);
      applyCanvasZoom();

      redrawBackgroundAndCanvas();
      // Restore previous drawing buffer
      ctx.drawImage(tempCanvas, 0, 0, mainCanvas.width, mainCanvas.height);
    }

    window.addEventListener('resize', resizeCanvas);

    const canvasFullscreenBtn = document.getElementById('canvasFullscreenBtn');
    function updateFullscreenButton() {
      const isFullscreen = document.fullscreenElement === workspaceScreen;
      canvasFullscreenBtn.setAttribute('aria-pressed', String(isFullscreen));
      canvasFullscreenBtn.innerHTML = isFullscreen
        ? '<i class="fa-solid fa-compress"></i> Exit full screen'
        : '<i class="fa-solid fa-expand"></i> Full screen';
      canvasFullscreenBtn.title = isFullscreen ? 'Exit full screen' : 'Expand workspace to full screen';
      requestAnimationFrame(() => resizeCanvas());
    }
    canvasFullscreenBtn.addEventListener('click', async () => {
      try {
        if (document.fullscreenElement === workspaceScreen) {
          await document.exitFullscreen();
        } else if (workspaceScreen.requestFullscreen) {
          await workspaceScreen.requestFullscreen();
        } else {
          showToast('Full screen is not supported by this browser.', 'info');
        }
      } catch (error) {
        console.warn('Full screen toggle failed:', error);
        showToast('Could not enter full screen. Try your browser’s full-screen option.', 'info');
      }
    });
    document.addEventListener('fullscreenchange', updateFullscreenButton);

    let currentBgImage = null;

    function redrawBackgroundAndCanvas() {
      ctx.clearRect(0, 0, mainCanvas.width, mainCanvas.height);

      const slideConfig = currentAssignmentData?.slides?.[currentSlideIndex];
      if (slideConfig?.bgUrl && !slideConfig.bgUrl.startsWith('data:image/')) {
        if (!currentBgImage || currentBgImage.src !== slideConfig.bgUrl) {
          currentBgImage = new Image();
          currentBgImage.crossOrigin = "anonymous";
          currentBgImage.src = slideConfig.bgUrl;
          currentBgImage.onload = () => {
            ctx.drawImage(currentBgImage, 0, 0, mainCanvas.width, mainCanvas.height);
          };
        } else {
          ctx.drawImage(currentBgImage, 0, 0, mainCanvas.width, mainCanvas.height);
        }
      }
    }

    function drawCanvasFromSlideData(slideData, isCurrent = () => true) {
      if (!slideData) return;
      const drawImageSource = src => {
        const img = new Image();
        // Storage download URLs are cross-origin. Set CORS mode before src so
        // drawing the archived canvas does not taint mainCanvas and block
        // getImageData()/toDataURL() during annotation and save.
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          if (!isDrawing && isCurrent()) ctx.drawImage(img, 0, 0, mainCanvas.width, mainCanvas.height);
        };
        img.onerror = () => console.warn('Could not load saved canvas image. Check Firebase Storage CORS configuration.');
        img.src = src;
      };
      // Prefer the live canvas while work is in progress; archived submissions use Storage.
      if (slideData.canvasData) {
        drawImageSource(slideData.canvasData);
      } else if (slideData.canvasStoragePath && storage) {
        storage.ref(slideData.canvasStoragePath).getDownloadURL()
          .then(url => {
            if (!isCurrent()) return;
            const separator = url.includes('?') ? '&' : '?';
            drawImageSource(url + separator + 'v=' + encodeURIComponent(
              slideData.updatedAt && typeof slideData.updatedAt.toMillis === 'function'
                ? slideData.updatedAt.toMillis()
                : Date.now()
            ));
          })
          .catch(err => console.warn('Could not load archived canvas from Storage:', err));
      }
    }

    function loadCurrentSlideData() {
      if (!currentAssignmentId) return;
      if (unsubSlideWork) { unsubSlideWork(); unsubSlideWork = null; }

      // Helpers must work on the requester's submitted canvas, not their own completed work.
      if (db && activeHelpRequestId && ['helper', 'teacher'].includes(activeHelpMode)
          && !(activeHelpMode === 'teacher' && inspectingStudentId)) {
        const requestId = activeHelpRequestId;
        const assignmentId = currentAssignmentId;
        const slideIndex = currentSlideIndex;
        unsubSlideWork = db.collection('assignments').doc(assignmentId)
          .collection('helpRequests').doc(requestId)
          .collection('slides').doc(`slide_${slideIndex}`)
          .onSnapshot(doc => {
            if (isDrawing || activeHelpRequestId !== requestId) return;
            redrawBackgroundAndCanvas();
            if (doc.exists) drawCanvasFromSlideData(doc.data() || {}, () =>
              !isDrawing && activeHelpRequestId === requestId
              && currentAssignmentId === assignmentId && currentSlideIndex === slideIndex);
          }, err => console.warn("Help request slide listener notice:", err));
        return;
      }

      const targetStudentId = inspectingStudentId || studentId;
      if (!targetStudentId) return;
      if (db) {
        const assignmentId = currentAssignmentId;
        const slideIndex = currentSlideIndex;
        unsubSlideWork = db.collection('assignments').doc(assignmentId)
          .collection('students').doc(targetStudentId)
          .collection('slides').doc(`slide_${slideIndex}`)
          .onSnapshot(doc => {
            if (isDrawing) return;
            redrawBackgroundAndCanvas();
            if (doc.exists) drawCanvasFromSlideData(doc.data() || {}, () =>
              !isDrawing && currentAssignmentId === assignmentId
              && currentSlideIndex === slideIndex
              && (inspectingStudentId || studentId) === targetStudentId);
          }, err => console.warn("Slide listener notice:", err));
      } else {
        redrawBackgroundAndCanvas();
      }
    }

    // Batch canvas persistence in fixed 2-second windows.
    let saveTimeout = null;
    let canvasSaveDirty = false;
    let canvasSaveInFlight = Promise.resolve();
    const CANVAS_SAVE_INTERVAL_MS = 2000;

    function saveCanvasToFirestore() {
      const targetStudentId = inspectingStudentId || studentId;
      if (!currentAssignmentId || !targetStudentId) return;
      canvasSaveDirty = true;
      if (saveTimeout === null) {
        saveTimeout = setTimeout(() => {
          saveTimeout = null;
          flushCanvasSaveToFirestore().catch(err => {
            console.error('Batched canvas save failed:', err);
            showToast('Save failed. Your latest drawing may not be stored.', 'error');
          });
        }, CANVAS_SAVE_INTERVAL_MS);
      }
    }

    async function flushCanvasSaveToFirestore() {
      if (saveTimeout !== null) {
        clearTimeout(saveTimeout);
        saveTimeout = null;
      }
      if (!canvasSaveDirty) return canvasSaveInFlight;
      canvasSaveDirty = false;
      const saveTask = canvasSaveInFlight.catch(() => {}).then(async () => {
        const targetStudentId = inspectingStudentId || studentId;
        const assignmentId = currentAssignmentId;
        const slideIndex = currentSlideIndex;
        if (!assignmentId) return;
        if (!targetStudentId && !(activeHelpRequestId && ['helper', 'teacher'].includes(activeHelpMode))) return;

        const exportCanvas = document.createElement('canvas');
        exportCanvas.width = mainCanvas.width;
        exportCanvas.height = mainCanvas.height;
        const exportCtx = exportCanvas.getContext('2d');
        exportCtx.fillStyle = '#ffffff';
        exportCtx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
        exportCtx.drawImage(mainCanvas, 0, 0);
        const dataUrl = exportCanvas.toDataURL('image/jpeg', 0.92);
        const now = firebase.firestore.FieldValue.serverTimestamp();

        if (db && activeHelpRequestId && ['helper', 'teacher'].includes(activeHelpMode)
            && !(activeHelpMode === 'teacher' && inspectingStudentId)) {
          await db.collection('assignments').doc(assignmentId)
            .collection('helpRequests').doc(activeHelpRequestId)
            .collection('slides').doc(`slide_${slideIndex}`)
            .set({ canvasData: dataUrl, updatedAt: now }, { merge: true });
          if (activeHelpMode === 'helper') {
            await db.collection('assignments').doc(assignmentId)
              .collection('helpRequests').doc(activeHelpRequestId)
              .update({ lastActivityAt: now, updatedAt: now });
          }
          return;
        }
        if (db && inspectingStudentId && currentUserRole === 'teacher') {
          // Submitted canvases may already live only in Storage. Save teacher annotations
          // directly to the same Storage object instead of recreating a large Firestore
          // canvasData field (which can exceed Firestore's document-size limit).
          const slideRef = db.collection('assignments').doc(assignmentId)
            .collection('students').doc(targetStudentId)
            .collection('slides').doc(`slide_${slideIndex}`);
          const slideSnapshot = await slideRef.get();
          const existingSlideData = slideSnapshot.exists ? (slideSnapshot.data() || {}) : {};
          const storagePath = existingSlideData.canvasStoragePath
            || `student-work/${assignmentId}/${targetStudentId}/slide_${slideIndex}.jpg`;
          const fileRef = storage.ref(storagePath);
          await fileRef.putString(dataUrl, 'data_url', {
            contentType: 'image/jpeg',
            cacheControl: 'private, max-age=0, no-cache'
          });
          await slideRef.set({
            canvasStoragePath: storagePath,
            canvasData: firebase.firestore.FieldValue.delete(),
            updatedAt: now,
            teacherAnnotatedAt: now,
            teacherAnnotatedBy: signedInUser?.uid || null
          }, { merge: true });
          return;
        }
        if (db && signedInUser && targetStudentId === signedInUser.uid && currentSubmissionStatus === 'in-progress') {
          await db.collection('assignments').doc(assignmentId)
            .collection('students').doc(targetStudentId)
            .collection('slides').doc(`slide_${slideIndex}`)
            .set({ canvasData: dataUrl, updatedAt: now }, { merge: true });
          await db.collection('assignments').doc(assignmentId)
            .collection('students').doc(targetStudentId).set({
              uid: targetStudentId,
              name: studentName || signedInUser.displayName || 'Student',
              lastWorkedAt: now
            }, { merge: true });
          await db.collection('users').doc(targetStudentId).collection('submissions').doc(assignmentId).set({
            assignmentId,
            classId: currentAssignmentData.classId || currentClassId,
            title: currentAssignmentData.title || 'Assignment',
            description: currentAssignmentData.description || '',
            sessionCode: currentSessionCode || currentAssignmentData.sessionCode || '',
            status: 'in-progress',
            lastWorkedAt: now,
            slideCount: (currentAssignmentData.slides || []).length
          }, { merge: true });
        }
      });
      canvasSaveInFlight = saveTask;
      await saveTask;
      if (canvasSaveDirty && saveTimeout === null) {
        saveTimeout = setTimeout(() => {
          saveTimeout = null;
          flushCanvasSaveToFirestore().catch(err => {
            console.error('Batched canvas save failed:', err);
            showToast('Save failed. Your latest drawing may not be stored.', 'error');
          });
        }, CANVAS_SAVE_INTERVAL_MS);
      }
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        flushCanvasSaveToFirestore().catch(err => console.warn('Canvas flush on background failed:', err));
      }
    });

    // ==========================================
    // DRAWING TOOLKIT & STYLUS POINTER EVENTS
    // ==========================================
    const toolPen = document.getElementById('toolPen');
    const toolEraser = document.getElementById('toolEraser');
    const toolText = document.getElementById('toolText');
    const colorPicker = document.getElementById('colorPicker');
    const brushSize = document.getElementById('brushSize');
    const inputModeBtn = document.getElementById('inputModeBtn');
    const inputModeIcon = document.getElementById('inputModeIcon');
    const inputModeText = document.getElementById('inputModeText');
    const undoCanvasBtn = document.getElementById('undoCanvasBtn');
    const redoCanvasBtn = document.getElementById('redoCanvasBtn');
    let undoStack = [];
    let redoStack = [];
    const MAX_HISTORY_STEPS = 50;

    function updateHistoryButtons() {
      undoCanvasBtn.disabled = undoStack.length === 0;
      redoCanvasBtn.disabled = redoStack.length === 0;
    }

    function captureCanvasState() {
      if (!mainCanvas.width || !mainCanvas.height) return null;
      try { return ctx.getImageData(0, 0, mainCanvas.width, mainCanvas.height); }
      catch (err) { console.warn('Could not capture canvas history:', err); return null; }
    }

    function beginCanvasAction() {
      const state = captureCanvasState();
      if (state) {
        undoStack.push(state);
        if (undoStack.length > MAX_HISTORY_STEPS) undoStack.shift();
        redoStack = [];
        updateHistoryButtons();
      }
    }

    function restoreCanvasState(state) {
      if (!state) return;
      if (state.width !== mainCanvas.width || state.height !== mainCanvas.height) {
        showToast('Undo history was reset because the canvas size changed.', 'info');
        undoStack = [];
        redoStack = [];
        updateHistoryButtons();
        return;
      }
      ctx.putImageData(state, 0, 0);
      saveCanvasToFirestore();
      updateHistoryButtons();
    }

    undoCanvasBtn.addEventListener('click', () => {
      if (currentUserRole === 'student' && currentSubmissionStatus !== 'in-progress') return;
      if (!undoStack.length) return;
      const current = captureCanvasState();
      if (current) redoStack.push(current);
      restoreCanvasState(undoStack.pop());
      updateHistoryButtons();
    });

    redoCanvasBtn.addEventListener('click', () => {
      if (currentUserRole === 'student' && currentSubmissionStatus !== 'in-progress') return;
      if (!redoStack.length) return;
      const current = captureCanvasState();
      if (current) undoStack.push(current);
      restoreCanvasState(redoStack.pop());
      updateHistoryButtons();
    });

    toolPen.addEventListener('click', () => setTool('pen'));
    toolEraser.addEventListener('click', () => setTool('eraser'));
    toolText.addEventListener('click', () => setTool('text'));

    colorPicker.addEventListener('input', (e) => {
      currentColor = e.target.value;
    });
    brushSize.addEventListener('input', (e) => {
      currentLineWidth = Number(e.target.value);
      if (eraserCursor && !eraserCursor.classList.contains('hidden')) {
        const canvasScale = mainCanvas.width ? mainCanvas.clientWidth / mainCanvas.width : 1;
        const diameter = Math.max(4, Number(currentLineWidth) * 4 * canvasScale);
        eraserCursor.style.width = `${diameter}px`;
        eraserCursor.style.height = `${diameter}px`;
      }
    });

    // Retain drawing preferences when opening another student's work or changing slides.
    function syncDrawingPreferencesToControls() {
      colorPicker.value = currentColor;
      brushSize.value = String(currentLineWidth);
    }

    // Toggle between Stylus Only (Palm Rejection) and Hand/Touch Mode
    inputModeBtn.addEventListener('click', () => {
      isStylusOnlyMode = !isStylusOnlyMode;
      if (isStylusOnlyMode) {
        inputModeBtn.className = "flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded transition bg-emerald-600 text-white shadow-sm";
        inputModeIcon.className = "fa-solid fa-pen-nib";
        inputModeText.textContent = "Stylus Only";
        showToast("Stylus Mode Enabled: Palm touches on canvas are ignored", "info");
      } else {
        inputModeBtn.className = "flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded transition bg-amber-500 text-white shadow-sm";
        inputModeIcon.className = "fa-solid fa-hand";
        inputModeText.textContent = "Touch & Hand";
        showToast("Touch Mode Enabled: Finger draw allowed", "info");
      }
    });

    const eraserCursor = document.getElementById('eraserCursor');

    function updateEraserCursor(e) {
      if (!eraserCursor || activeTool !== 'eraser') return;
      const rect = canvasWrapper.getBoundingClientRect();
      eraserCursor.style.left = `${e.clientX - rect.left}px`;
      eraserCursor.style.top = `${e.clientY - rect.top}px`;
      const canvasScale = mainCanvas.width ? mainCanvas.clientWidth / mainCanvas.width : 1;
      const diameter = Math.max(4, Number(currentLineWidth) * 4 * canvasScale);
      eraserCursor.style.width = `${diameter}px`;
      eraserCursor.style.height = `${diameter}px`;
      eraserCursor.classList.remove('hidden');
    }

    canvasWrapper.addEventListener('pointermove', updateEraserCursor);
    canvasWrapper.addEventListener('pointerleave', () => eraserCursor?.classList.add('hidden'));

    function setTool(tool) {
      activeTool = tool;
      if (eraserCursor) eraserCursor.classList.toggle('hidden', tool !== 'eraser');
      [toolPen, toolEraser, toolText].forEach(btn => {
        btn.classList.remove('bg-indigo-600', 'text-white');
        btn.classList.add('bg-white', 'text-slate-700', 'hover:bg-slate-200');
      });

      if (tool === 'pen') {
        toolPen.classList.add('bg-indigo-600', 'text-white');
        toolPen.classList.remove('bg-white', 'text-slate-700');
      } else if (tool === 'eraser') {
        toolEraser.classList.add('bg-indigo-600', 'text-white');
        toolEraser.classList.remove('bg-white', 'text-slate-700');
      } else if (tool === 'text') {
        toolText.classList.add('bg-indigo-600', 'text-white');
        toolText.classList.remove('bg-white', 'text-slate-700');
      }
    }

    const capturePhotoBtn = document.getElementById('capturePhotoBtn');
    const capturePhotoInput = document.getElementById('capturePhotoInput');
    const chooseImageBtn = document.getElementById('chooseImageBtn');
    const chooseImageInput = document.getElementById('chooseImageInput');

    function canAddImageToCanvas() {
      if (currentUserRole === 'student' && currentSubmissionStatus !== 'in-progress') {
        showToast('This assignment is read-only until your teacher requests amendments.', 'info');
        return false;
      }
      if (!currentAssignmentId) {
        showToast('Open an assignment before adding an image.', 'info');
        return false;
      }
      return true;
    }

    capturePhotoBtn.addEventListener('click', () => {
      if (!canAddImageToCanvas()) return;
      capturePhotoInput.value = '';
      capturePhotoInput.click();
    });

    chooseImageBtn.addEventListener('click', () => {
      if (!canAddImageToCanvas()) return;
      chooseImageInput.value = '';
      chooseImageInput.click();
    });

    function handleImageFileChange(event) {
      const input = event.target;
      const file = input.files && input.files[0];
      if (!file) return;
      if (!file.type.startsWith('image/')) {
        showToast('Please choose a valid image file.', 'error');
        input.value = '';
        return;
      }

      const imageUrl = URL.createObjectURL(file);
      const photo = new Image();
      photo.onload = () => {
        try {
          beginCanvasAction();

          // Fit the image within the slide while preserving its aspect ratio.
          const padding = Math.max(12, Math.min(mainCanvas.width, mainCanvas.height) * 0.04);
          const maxWidth = Math.max(1, mainCanvas.width - padding * 2);
          const maxHeight = Math.max(1, mainCanvas.height - padding * 2);
          const scale = Math.min(maxWidth / photo.naturalWidth, maxHeight / photo.naturalHeight);
          const drawWidth = photo.naturalWidth * scale;
          const drawHeight = photo.naturalHeight * scale;
          const drawX = (mainCanvas.width - drawWidth) / 2;
          const drawY = (mainCanvas.height - drawHeight) / 2;

          ctx.drawImage(photo, drawX, drawY, drawWidth, drawHeight);
          saveCanvasToFirestore();
          showToast('Image added to this slide and will be saved with the student’s work.', 'success');
        } catch (err) {
          console.error('Image insertion failed:', err);
          showToast('Could not add this image. Please try again.', 'error');
        } finally {
          URL.revokeObjectURL(imageUrl);
          input.value = '';
        }
      };
      photo.onerror = () => {
        URL.revokeObjectURL(imageUrl);
        input.value = '';
        showToast('Could not open that image. Please try again.', 'error');
      };
      photo.src = imageUrl;
    }

    capturePhotoInput.addEventListener('change', handleImageFileChange);
    chooseImageInput.addEventListener('change', handleImageFileChange);

    document.getElementById('clearCanvasBtn').addEventListener('click', () => {
      if (currentUserRole === 'student' && currentSubmissionStatus !== 'in-progress') {
        showToast('This assignment is read-only until your teacher requests amendments.', 'info');
        return;
      }
      if (!window.confirm('Clear all writing on this slide? This action can be undone with Undo.')) return;
      beginCanvasAction();
      redrawBackgroundAndCanvas();
      saveCanvasToFirestore();
    });

    // Canvas zoom is applied with CSS transforms; convert pointer positions back to canvas space.
    let canvasZoom = 1;
    let canvasPanX = 0;
    let canvasPanY = 0;
    const MIN_CANVAS_ZOOM = 1;
    const MAX_CANVAS_ZOOM = 3.5;

    function applyCanvasZoom() {
      mainCanvas.style.transform = `translate(${canvasPanX}px, ${canvasPanY}px) scale(${canvasZoom})`;
      const label = document.getElementById('canvasZoomLabel');
      if (label) label.textContent = Math.round(canvasZoom * 100) + '%';
    }

    function setCanvasZoom(nextZoom, anchorX, anchorY) {
      const wrapperRect = canvasWrapper.getBoundingClientRect();
      const cx = anchorX ?? wrapperRect.width / 2;
      const cy = anchorY ?? wrapperRect.height / 2;
      const oldZoom = canvasZoom;
      const next = Math.max(MIN_CANVAS_ZOOM, Math.min(MAX_CANVAS_ZOOM, nextZoom));
      if (next === oldZoom) return;
      // Keep the canvas point under the anchor stationary while changing zoom.
      canvasPanX = cx - (cx - canvasPanX) * (next / oldZoom);
      canvasPanY = cy - (cy - canvasPanY) * (next / oldZoom);
      canvasZoom = next;
      if (canvasZoom === 1) { canvasPanX = 0; canvasPanY = 0; }
      applyCanvasZoom();
    }

    function resetCanvasZoom() {
      canvasZoom = 1; canvasPanX = 0; canvasPanY = 0;
      applyCanvasZoom();
    }

    document.getElementById('canvasZoomInBtn').addEventListener('click', () => setCanvasZoom(canvasZoom + 0.25));
    document.getElementById('canvasZoomOutBtn').addEventListener('click', () => setCanvasZoom(canvasZoom - 0.25));
    document.getElementById('canvasZoomResetBtn').addEventListener('click', resetCanvasZoom);

    // Two-finger gestures support both pinch-to-zoom and drag-to-pan.
    // One-finger/stylus input remains available for writing.
    let pinchStartDistance = 0;
    let pinchStartZoom = 1;
    let pinchStartMidpoint = null;
    let pinchStartPanX = 0;
    let pinchStartPanY = 0;

    function getTwoFingerGesture(e) {
      const p1 = e.touches[0], p2 = e.touches[1];
      const rect = canvasWrapper.getBoundingClientRect();
      return {
        distance: Math.hypot(p2.clientX - p1.clientX, p2.clientY - p1.clientY),
        midpoint: {
          x: (p1.clientX + p2.clientX) / 2 - rect.left,
          y: (p1.clientY + p2.clientY) / 2 - rect.top
        }
      };
    }

    function resetTwoFingerGesture() {
      pinchStartDistance = 0;
      pinchStartMidpoint = null;
    }

    canvasWrapper.addEventListener('touchstart', e => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const gesture = getTwoFingerGesture(e);
        pinchStartDistance = Math.max(1, gesture.distance);
        pinchStartZoom = canvasZoom;
        pinchStartMidpoint = gesture.midpoint;
        pinchStartPanX = canvasPanX;
        pinchStartPanY = canvasPanY;
        isDrawing = false;
      }
    }, { passive: false });

    canvasWrapper.addEventListener('touchmove', e => {
      if (e.touches.length !== 2 || !pinchStartDistance || !pinchStartMidpoint) return;
      e.preventDefault();
      const gesture = getTwoFingerGesture(e);
      const nextZoom = Math.max(
        MIN_CANVAS_ZOOM,
        Math.min(MAX_CANVAS_ZOOM, pinchStartZoom * gesture.distance / pinchStartDistance)
      );

      // Keep the original canvas point under the fingers' moving midpoint.
      // If finger spacing stays the same, this becomes two-finger panning.
      const contentX = (pinchStartMidpoint.x - pinchStartPanX) / pinchStartZoom;
      const contentY = (pinchStartMidpoint.y - pinchStartPanY) / pinchStartZoom;
      canvasZoom = nextZoom;
      canvasPanX = gesture.midpoint.x - contentX * canvasZoom;
      canvasPanY = gesture.midpoint.y - contentY * canvasZoom;

      if (canvasZoom === 1) {
        canvasPanX = 0;
        canvasPanY = 0;
      }
      applyCanvasZoom();
    }, { passive: false });

    canvasWrapper.addEventListener('touchend', e => {
      if (e.touches.length < 2) resetTwoFingerGesture();
    }, { passive: true });
    canvasWrapper.addEventListener('touchcancel', resetTwoFingerGesture, { passive: true });

    function getCanvasCoordinates(e, rect = canvasWrapper.getBoundingClientRect()) {
      return {
        x: ((e.clientX - rect.left - canvasPanX) / canvasZoom) * (mainCanvas.width / canvasWrapper.clientWidth),
        y: ((e.clientY - rect.top - canvasPanY) / canvasZoom) * (mainCanvas.height / canvasWrapper.clientHeight)
      };
    }
    // Advanced Pointer Events for Stylus / Apple Pencil + Palm Rejection Toggle
    function handlePointerDown(e) {
      // Completed students may draw while helping; their own assignment remains read-only.
      if (currentUserRole === 'student' && currentSubmissionStatus !== 'in-progress'
          && !['helper', 'teacher'].includes(activeHelpMode)) {
        showToast('This assignment is read-only until your teacher requests amendments.', 'info');
        return;
      }
      // In Stylus Only mode, filter out touch/finger input to reject palm contact completely
      if (isStylusOnlyMode && e.pointerType === 'touch') {
        return;
      }

      const coords = getCanvasCoordinates(e);

      if (activeTool === 'text') {
        const text = prompt("Enter text overlay:");
        if (text) {
          beginCanvasAction();
          ctx.font = `${currentLineWidth * 4 + 12}px Inter, sans-serif`;
          ctx.fillStyle = currentColor;
          ctx.fillText(text, coords.x, coords.y);
          saveCanvasToFirestore();
        }
        return;
      }

      beginCanvasAction();
      isDrawing = true;
      lastX = coords.x;
      lastY = coords.y;
      ctx.strokeStyle = activeTool === 'eraser' ? '#ffffff' : currentColor;
      ctx.lineWidth = activeTool === 'eraser' ? (Number(currentLineWidth) * 4) / canvasZoom : Number(currentLineWidth) / canvasZoom;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      mainCanvas.setPointerCapture(e.pointerId);
    }

    function handlePointerMove(e) {
      if (!isDrawing) return;

      // Filter touch points in Stylus Only mode during motion
      if (isStylusOnlyMode && e.pointerType === 'touch') {
        return;
      }

      e.preventDefault();

      // Process coalesced pointer samples where supported for smoother handwriting,
      // while measuring the wrapper only once per browser event.
      const rect = canvasWrapper.getBoundingClientRect();
      const samples = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
      const points = samples.length ? samples : [e];

      // Keep visible stroke thickness constant at every zoom level.
      if (activeTool === 'eraser') {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = (currentLineWidth * 4) / canvasZoom;
      } else {
        ctx.strokeStyle = currentColor;
        ctx.lineWidth = currentLineWidth / canvasZoom;
      }
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      for (const point of points) {
        const coords = getCanvasCoordinates(point, rect);
        ctx.beginPath();
        ctx.moveTo(lastX, lastY);
        ctx.lineTo(coords.x, coords.y);
        ctx.stroke();
        lastX = coords.x;
        lastY = coords.y;
      }
    }

    function handlePointerUp(e) {
      if (isDrawing) {
        isDrawing = false;
        try {
          mainCanvas.releasePointerCapture(e.pointerId);
        } catch (err) {}
        saveCanvasToFirestore();
      }
    }

    mainCanvas.addEventListener('pointerdown', handlePointerDown);
    mainCanvas.addEventListener('pointermove', handlePointerMove);
    mainCanvas.addEventListener('pointerup', handlePointerUp);
    mainCanvas.addEventListener('pointercancel', handlePointerUp);

    // Prevent default touch gestures on canvas wrapper to stop page reset / reload on swipe
    canvasWrapper.addEventListener('touchstart', (e) => {
      if (isStylusOnlyMode && e.touches.length > 0 && e.touches[0].touchType !== 'stylus') {
        return; // Allow page scroll if in stylus mode and touching with hand outside canvas stroke
      }
    }, { passive: true });


    // PEER HELP WORKFLOW
    // ==========================================
    function peerHelpRequestRef(requestId) {
      return db.collection('assignments').doc(currentAssignmentId).collection('helpRequests').doc(requestId);
    }

    function peerHelpOwnerRef(requestId) {
      return db.collection('assignments').doc(currentAssignmentId).collection('helpRequestOwners').doc(requestId);
    }

    function peerHelpLockRef(workKey) {
      return db.collection('assignments').doc(currentAssignmentId).collection('helpLocks').doc(workKey);
    }

    function exportCanvasJpeg() {
      const output = document.createElement('canvas');
      output.width = mainCanvas.width;
      output.height = mainCanvas.height;
      const outputCtx = output.getContext('2d');
      outputCtx.fillStyle = '#fff';
      outputCtx.fillRect(0, 0, output.width, output.height);
      outputCtx.drawImage(mainCanvas, 0, 0);
      return output.toDataURL('image/jpeg', 0.92);
    }

    function updatePeerHelpControls() {
      const panel = document.getElementById('peerHelpPanel');
      if (panel) panel.classList.toggle('hidden', !currentAssignmentId || !signedInUser);
      const helperMode = activeHelpMode === 'helper';
      const teacherMode = activeHelpMode === 'teacher';
      // Teachers inspecting a student's submitted work need the full annotation toolbar.
      // Keep the restricted, fixed-colour toolbar only for active help sessions
      // that are not the teacher's normal student-work inspection view.
      const restrictedHelpMode = helperMode || (teacherMode && !inspectingStudentId);
      // A helper may also have an outstanding request of their own. That request's
      // lock must never disable the canvas while they are actively helping someone else.
      const requesterIsLocked = requesterHelpLock && currentUserRole === 'student' && !inspectingStudentId && !helperMode && !teacherMode;
      const lockBadge = document.getElementById('peerHelpStatusBadge');
      const submitHelper = document.getElementById('submitPeerHelpBtn');
      const submitTeacher = document.getElementById('teacherSubmitPeerHelpBtn');
      if (submitHelper) submitHelper.classList.toggle('hidden', !helperMode);
      if (submitTeacher) submitTeacher.classList.toggle('hidden', !teacherMode);
      if (lockBadge) {
        const visible = requesterIsLocked || helperMode || teacherMode;
        lockBadge.classList.toggle('hidden', !visible);
        lockBadge.textContent = requesterIsLocked ? 'Someone is helping' : (helperMode ? 'Helping a peer' : (teacherMode ? 'Reviewing help session' : ''));
        lockBadge.classList.toggle('peer-help-pulse', requesterIsLocked || helperMode);
      }
      const colorPicker = document.getElementById('colorPicker');
      const eraser = document.getElementById('toolEraser');
      const textTool = document.getElementById('toolText');
      const penTool = document.getElementById('toolPen');
      ['toolPen', 'toolEraser', 'toolText', 'colorPicker', 'brushSize', 'clearCanvasBtn', 'capturePhotoBtn', 'chooseImageBtn', 'undoCanvasBtn', 'redoCanvasBtn', 'prevSlideBtn', 'nextSlideBtn'].forEach(id => {
        const control = document.getElementById(id);
        if (control) {
          control.disabled = requesterIsLocked || (restrictedHelpMode && !['toolPen', 'brushSize', 'undoCanvasBtn', 'redoCanvasBtn'].includes(id));
        }
      });
      // Peer helpers use a fixed rose-colour pen. Teachers inspecting student work
      // retain the normal tools and colour picker, with red selected as the default.
      if (colorPicker) {
        colorPicker.disabled = requesterIsLocked || restrictedHelpMode;
        if (restrictedHelpMode) colorPicker.value = PEER_HELP_COLOUR;
      }
      if (eraser) eraser.disabled = requesterIsLocked || restrictedHelpMode;
      if (textTool) textTool.disabled = requesterIsLocked || restrictedHelpMode;
      if (penTool && (requesterIsLocked || restrictedHelpMode)) {
        activeTool = 'pen';
        penTool.classList.add('bg-indigo-600', 'text-white');
        penTool.classList.remove('bg-white', 'text-slate-700');
      }
      if (mainCanvas) mainCanvas.style.pointerEvents = requesterIsLocked ? 'none' : 'auto';
      const askButton = document.getElementById('askForHelpBtn');
      if (askButton) askButton.innerHTML = isPeerHelpEnabled() ? '<i class="fa-solid fa-handshake-angle mr-1"></i> Peer Help' : '<i class="fa-solid fa-chalkboard-teacher mr-1"></i> Teacher Help';
      updateSubmitAssignmentButton();
    }

    function renderPeerHelpRequests(requests, audience = 'student') {
      const list = document.getElementById('peerHelpRequestList');
      const teacherList = document.getElementById('teacherPeerHelpList');
      if (audience === 'teacher' && !teacherList) return;
      const target = audience === 'teacher' ? teacherList : list;
      if (audience !== 'teacher') requests = requests.filter(item => item.requestMode === 'peer');
      if (!target) return;
      if (audience !== 'teacher') {
        const badge = document.getElementById('peerHelpCountBadge');
        if (badge) {
          const count = requests.filter(item => item.status === 'pending').length;
          badge.textContent = count === 1 ? '1 new help request' : `${count} new help requests`;
          badge.classList.toggle('hidden', count === 0);
        }
      }
      target.querySelectorAll('[data-peer-request]').forEach(node => node.remove());
      const oldEmpty = target.querySelector('[data-peer-help-empty]');
      if (oldEmpty) oldEmpty.remove();
      if (!requests.length) {
        if (!target.querySelector('[data-owned-request]')) {
          const empty = document.createElement('p');
          empty.dataset.peerHelpEmpty = 'true';
          empty.className = 'text-sm text-slate-500';
          empty.textContent = 'No peer help requests to show.';
          target.appendChild(empty);
        }
        return;
      }
      requests.sort((a, b) => {
        const order = { helping: 0, pending: 1, submitted: 2, acknowledged: 3, expired: 4 };
        return (order[a.status] ?? 5) - (order[b.status] ?? 5);
      }).forEach(item => {
        const card = document.createElement('div');
        card.className = 'peer-help-request-card';
        card.dataset.status = item.status || 'pending';
        card.dataset.peerRequest = item.id;
        const mode = document.createElement('p');
        mode.className = 'text-[11px] font-bold uppercase tracking-wide text-sky-700 mt-1';
        mode.textContent = item.requestMode === 'teacher' ? 'Teacher Help' : 'Peer Help';
        const question = document.createElement('p');
        question.className = 'text-sm font-semibold text-slate-800 whitespace-pre-wrap';
        question.textContent = item.question || 'Help request';
        const status = document.createElement('p');
        status.className = 'text-xs text-slate-500 mt-1';
        status.textContent = audience === 'teacher' && item.status === 'helping'
          ? 'Someone is helping • Active session'
          : (item.status || 'pending').replace(/-/g, ' ').replace(/^./, x => x.toUpperCase());
        if (audience === 'teacher' && item.status === 'helping') {
          status.className = 'inline-flex mt-2 rounded-full bg-amber-100 text-amber-800 border border-amber-300 px-2.5 py-1 text-xs font-bold peer-help-pulse';
        }
        if (audience === 'teacher' && item.requesterLabel) {
          const requester = document.createElement('p');
          requester.className = 'text-xs text-slate-600 mt-1';
          requester.textContent = 'Requester: ' + item.requesterLabel;
          card.appendChild(requester);
        }
        card.append(mode, question, status);
        const actions = document.createElement('div');
        actions.className = 'flex flex-wrap gap-2 mt-3';
        const addAction = (label, className, callback) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = className;
          btn.textContent = label;
          btn.addEventListener('click', callback);
          actions.appendChild(btn);
        };
        if (audience === 'teacher') {
          if (item.status === 'helping') {
            addAction('Submit on behalf', 'px-3 py-1.5 rounded-lg bg-rose-600 text-white text-xs font-semibold', () => submitPeerHelp(item.id, true));
            addAction('Release lock', 'px-3 py-1.5 rounded-lg border border-slate-300 text-slate-600 text-xs font-semibold', () => expirePeerHelpRequest(item.id));
          }
          if (item.status === 'pending') {
            addAction('Help this student', 'px-3 py-1.5 rounded-lg bg-sky-600 text-white text-xs font-semibold', () => claimPeerHelpRequestAsTeacher(item.id));
            addAction('Expire request', 'px-3 py-1.5 rounded-lg border border-slate-300 text-slate-600 text-xs font-semibold', () => expirePeerHelpRequest(item.id));
          }
          const activityStamp = item.lastActivityAt || item.claimedAt;
          const elapsed = activityStamp?.toDate ? Math.max(0, Math.round((Date.now() - activityStamp.toDate().getTime()) / 60000)) : null;
          if (item.status === 'helping' && elapsed !== null) {
            const timer = document.createElement('span');
            timer.className = 'self-center text-xs font-semibold ' + (elapsed >= 5 ? 'text-rose-700' : 'text-amber-800');
            timer.textContent = elapsed >= 5 ? `No activity for ${elapsed} min — check or recover session` : `Last activity ${elapsed} min ago`;
            actions.appendChild(timer);
          }
        } else if (item.status === 'pending' && currentSubmissionStatus === 'completed' && !activeHelpRequestId) {
          addAction('Help this student', 'px-3 py-1.5 rounded-lg bg-sky-600 text-white text-xs font-semibold', () => claimPeerHelpRequest(item.id));
        } else if ((item.status === 'submitted' || item.status === 'acknowledged') && item.isOwned) {
          const done = document.createElement('span');
          done.className = 'text-xs font-semibold text-emerald-700';
          done.textContent = 'Help completed';
          actions.appendChild(done);
        } else if (item.status === 'helping' && item.isOwned) {
          const active = document.createElement('span');
          active.className = 'text-xs font-bold text-amber-800 peer-help-pulse rounded-full px-2 py-1';
          active.textContent = 'Someone is helping';
          actions.appendChild(active);
        } else if (item.status === 'acknowledged' && item.isOwned) {
          const done = document.createElement('span');
          done.className = 'text-xs font-semibold text-emerald-700';
          done.textContent = 'Thanks recorded';
          actions.appendChild(done);
        }
        if (actions.childElementCount) card.appendChild(actions);
        target.appendChild(card);
      });
    }

    function startPeerHelpListeners() {
      if (!db || !signedInUser || !currentAssignmentId) return;
      const assignmentChanged = peerHelpListeningAssignmentId !== currentAssignmentId;
      if (assignmentChanged) {
        if (unsubHelpRequests) { unsubHelpRequests(); unsubHelpRequests = null; }
        if (unsubOwnedHelpRequests) { unsubOwnedHelpRequests(); unsubOwnedHelpRequests = null; }
        if (unsubTeacherHelpRequests) { unsubTeacherHelpRequests(); unsubTeacherHelpRequests = null; }
        ownedHelpRequestListeners.forEach(unsub => unsub());
        ownedHelpRequestListeners.clear();
        finishedOwnedHelpRequestListeners.clear();
        ownedHelpRequestState.clear();
        loadClearedOwnedHelpLogIds();
        teacherRequesterLabelCache.clear();
        requesterHelpLock = false;
        peerHelpListeningAssignmentId = currentAssignmentId;
      } else if (unsubHelpRequests) {
        unsubHelpRequests();
        unsubHelpRequests = null;
      }

      const panel = document.getElementById('peerHelpPanel');
      if (panel) panel.classList.toggle('hidden', !currentAssignmentId || !signedInUser);
      const queue = document.getElementById('peerHelpRequestList');
      const refresh = document.getElementById('refreshPeerHelpBtn');
      const hint = document.getElementById('peerHelpPanelHint');
      const peerMode = isPeerHelpEnabled();
      if (queue) queue.classList.toggle('hidden', currentUserRole !== 'teacher' && !peerMode);
      if (refresh) refresh.classList.toggle('hidden', currentUserRole !== 'teacher' && !peerMode);
      const clearLogButton = document.getElementById('clearPeerHelpLogBtn');
      if (clearLogButton) clearLogButton.classList.toggle('hidden', currentUserRole === 'teacher');
      if (hint) hint.textContent = peerMode ? 'Ask for help or help a peer with this assignment.' : 'Teacher Help only. Your latest two requests appear below.';

      const requestsRef = db.collection('assignments').doc(currentAssignmentId).collection('helpRequests');
      if (currentUserRole === 'teacher') {
        startTeacherHelpMonitor(currentAssignmentId);
      } else if (currentSubmissionStatus === 'completed' && isPeerHelpEnabled()) {
        // Fetch only while Peer Help is enabled; no assignment-wide student listener.
        requestsRef.where('status', '==', 'pending').where('requestMode', '==', 'peer').limit(10).get().then(snapshot => {
          renderPeerHelpRequests(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
        }).catch(err => console.warn('Available Peer Help fetch:', err));
      } else {
        const list = document.getElementById('peerHelpRequestList');
        if (list) list.innerHTML = '<p class="text-sm text-slate-500">Only students who completed this assignment can help. Your requests will appear here.</p>';
      }

      // Keep one owner listener per assignment; reuse it when the panel refreshes.
      if (unsubOwnedHelpRequests) return;
      const ownersRef = db.collection('assignments').doc(currentAssignmentId).collection('helpRequestOwners');
      unsubOwnedHelpRequests = ownersRef.where('requesterUid', '==', signedInUser.uid).onSnapshot(snapshot => {
        const ownerIds = new Set(snapshot.docs.map(d => d.id));
        ownedHelpRequestListeners.forEach((unsub, requestId) => {
          if (!ownerIds.has(requestId)) {
            unsub();
            ownedHelpRequestListeners.delete(requestId);
            ownedHelpRequestState.delete(requestId);
          }
        });
        snapshot.docs.forEach(ownerDoc => {
          if (ownedHelpRequestListeners.has(ownerDoc.id) || finishedOwnedHelpRequestListeners.has(ownerDoc.id)) return;
          const unsub = requestsRef.doc(ownerDoc.id).onSnapshot(async requestDoc => {
            if (!requestDoc.exists) return;
            const data = requestDoc.data();
            const item = { id: requestDoc.id, ...data, isOwned: true };
            if (data.status === 'helping') {
              requesterHelpLock = true;
              updatePeerHelpControls();
            } else if (data.status === 'submitted') {
              // Keep the requester locked until the submitted help canvas has been copied.
              requesterHelpLock = true;
              updatePeerHelpControls();
              if (!copiedHelpResults.has(requestDoc.id) && !copyingHelpResults.has(requestDoc.id)) {
                copyingHelpResults.add(requestDoc.id);
                copiedHelpResults.add(requestDoc.id);
                try {
                  const slideIndex = Number(data.slideIndex || 0);
                  const slideDoc = await requestsRef.doc(requestDoc.id).collection('slides').doc(`slide_${slideIndex}`).get();
                  if (!slideDoc.exists || !slideDoc.data().canvasData) throw new Error('The saved help canvas was not found.');
                  await db.collection('assignments').doc(currentAssignmentId).collection('students').doc(signedInUser.uid)
                    .collection('slides').doc(`slide_${slideIndex}`)
                    .set({ canvasData: slideDoc.data().canvasData, updatedAt: firebase.firestore.FieldValue.serverTimestamp(), peerHelpRequestId: requestDoc.id }, { merge: true });
                  // Auto-complete after the requester canvas is safely updated; no Thanks action is needed.
                  await db.runTransaction(async transaction => {
                    const latestRequest = await transaction.get(requestsRef.doc(requestDoc.id));
                    const lockRef = peerHelpLockRef(data.workKey);
                    const latestLock = await transaction.get(lockRef);
                    if (latestRequest.exists && latestRequest.data().status === 'submitted') {
                      const completedAt = firebase.firestore.FieldValue.serverTimestamp();
                      transaction.update(requestsRef.doc(requestDoc.id), { status: 'acknowledged', completedAt, updatedAt: completedAt });
                      if (latestLock.exists && latestLock.data().status === 'submitted') transaction.update(lockRef, { status: 'acknowledged', updatedAt: completedAt });
                    }
                  });
                  item.status = 'acknowledged';
                  // Switch the requester back to the exact slide just updated and
                  // force a fresh subscription so the visible canvas matches Firestore.
                  currentSlideIndex = slideIndex;
                  updateSlideNavigationUI();
                  if (!activeHelpRequestId) {
                    loadCurrentSlideData();
                    // Reuse the help-slide data already fetched above, avoiding an extra
                    // Firestore read while immediately painting the saved result.
                    const refreshedCanvasData = slideDoc.data().canvasData;
                    if (refreshedCanvasData && !isDrawing) {
                      const refreshedImage = new Image();
                      refreshedImage.onload = () => {
                        if (!isDrawing && !activeHelpRequestId && currentSlideIndex === slideIndex) {
                          ctx.clearRect(0, 0, mainCanvas.width, mainCanvas.height);
                          ctx.drawImage(refreshedImage, 0, 0, mainCanvas.width, mainCanvas.height);
                        }
                      };
                      refreshedImage.src = refreshedCanvasData;
                    }
                  }
                } catch (err) {
                  copiedHelpResults.delete(requestDoc.id);
                  console.error('Could not apply peer annotations to requester canvas:', err);
                  showToast('Help was submitted, but the annotated canvas could not be copied. You can continue working; inform your teacher if needed.', 'error');
                } finally {
                  copyingHelpResults.delete(requestDoc.id);
                  requesterHelpLock = false;
                  updatePeerHelpControls();
                  if (copiedHelpResults.has(requestDoc.id)) {
                    const stopListening = ownedHelpRequestListeners.get(requestDoc.id);
                    if (stopListening) stopListening();
                    ownedHelpRequestListeners.delete(requestDoc.id);
                    finishedOwnedHelpRequestListeners.add(requestDoc.id);
                  }
                }
              } else if (copyingHelpResults.has(requestDoc.id)) {
                requesterHelpLock = true;
                updatePeerHelpControls();
              } else {
                requesterHelpLock = false;
                updatePeerHelpControls();
              }
            } else if (['acknowledged', 'expired', 'cancelled'].includes(data.status)) {
              requesterHelpLock = false;
              updatePeerHelpControls();
              const stopListening = ownedHelpRequestListeners.get(requestDoc.id);
              if (stopListening) {
                stopListening();
                ownedHelpRequestListeners.delete(requestDoc.id);
                finishedOwnedHelpRequestListeners.add(requestDoc.id);
              }
            }
            ownedHelpRequestState.set(item.id, item);
            renderOwnedPeerHelpRequests(Array.from(ownedHelpRequestState.values()));
          }, err => console.warn('Owned Peer Help listener:', err));
          ownedHelpRequestListeners.set(ownerDoc.id, unsub);
        });
        if (!snapshot.docs.length) {
          hasOpenOwnedHelpRequest = false;
          renderOwnedPeerHelpRequests([]);
          updatePeerHelpControls();
        }
      }, err => console.warn('Private Peer Help owner listener:', err));
    }

    function renderOwnedPeerHelpRequests(items) {
      const list = document.getElementById('peerHelpActivityLog');
      hasOpenOwnedHelpRequest = items.some(item => ['pending', 'helping'].includes(item.status));
      updateSubmitAssignmentButton();
      if (!list) return;
      list.innerHTML = '';
      const latestItems = items.filter(item => !clearedOwnedHelpLogIds.has(item.id)).slice().sort((a, b) => {
        const at = a.createdAt?.toDate ? a.createdAt.toDate().getTime() : 0;
        const bt = b.createdAt?.toDate ? b.createdAt.toDate().getTime() : 0;
        return bt - at;
      }).slice(0, 2);
      if (!latestItems.length) {
        list.innerHTML = '<p class="text-xs text-slate-400">No recent requests.</p>';
        return;
      }
      latestItems.forEach(item => {
        const card = document.createElement('div');
        card.className = 'peer-help-request-card';
        card.dataset.ownedRequest = item.id;
        card.dataset.status = item.status || 'pending';
        const question = document.createElement('p');
        question.className = 'text-sm font-semibold text-slate-800 whitespace-pre-wrap';
        question.textContent = item.question || 'Your help request';
        const status = document.createElement('p');
        status.className = 'text-xs text-slate-500 mt-1';
        status.textContent = item.status === 'helping' ? 'Someone is helping — your canvas is locked temporarily.' :
          item.status === 'submitted' || item.status === 'acknowledged' ? 'Help completed. You can continue working.' :
          item.status === 'cancelled' ? 'You cancelled this request. You can continue working.' :
          item.status === 'expired' ? 'Request expired. You can continue working.' : 'Waiting for an eligible peer.';
        card.append(question, status);
        if (item.status === 'pending') {
          const actions = document.createElement('div');
          actions.className = 'mt-2';
          const cancelButton = document.createElement('button');
          cancelButton.type = 'button';
          cancelButton.className = 'px-2.5 py-1 rounded-md border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 text-xs font-semibold';
          cancelButton.textContent = 'Cancel request';
          cancelButton.addEventListener('click', () => cancelOwnedPeerHelpRequest(item.id));
          actions.appendChild(cancelButton);
          card.appendChild(actions);
        }
        list.prepend(card);
      });
    }

    async function cancelOwnedPeerHelpRequest(requestId) {
      if (!signedInUser || !currentAssignmentId || !requestId) return;
      const item = ownedHelpRequestState.get(requestId);
      if (!item || item.status !== 'pending') {
        showToast('This request can only be cancelled before someone starts helping.', 'info');
        return;
      }
      const card = document.querySelector(`[data-owned-request="${requestId}"]`);
      const button = card?.querySelector('button');
      if (button) button.disabled = true;
      try {
        const requestRef = peerHelpRequestRef(requestId);
        await db.runTransaction(async transaction => {
          const requestSnapshot = await transaction.get(requestRef);
          if (!requestSnapshot.exists || requestSnapshot.data().status !== 'pending') {
            throw new Error('Someone has already started helping, or this request is no longer pending.');
          }
          const lockRef = peerHelpLockRef(requestSnapshot.data().workKey);
          const lockSnapshot = await transaction.get(lockRef);
          if (!lockSnapshot.exists || lockSnapshot.data().status !== 'pending') {
            throw new Error('This request has already been claimed and cannot be cancelled.');
          }
          const now = firebase.firestore.FieldValue.serverTimestamp();
          transaction.update(requestRef, { status: 'cancelled', cancelledAt: now, updatedAt: now });
          transaction.update(lockRef, { status: 'cancelled', updatedAt: now });
        });
        showToast('Help request cancelled.', 'success');
      } catch (err) {
        console.warn('Could not cancel help request:', err);
        showToast(err.message || 'Could not cancel this help request.', 'error');
      }
    }

    function clearOwnedPeerHelpLog() {
      Array.from(ownedHelpRequestState.keys()).forEach(id => clearedOwnedHelpLogIds.add(id));
      const key = ownedHelpLogStorageKey();
      if (key) {
        try { localStorage.setItem(key, JSON.stringify(Array.from(clearedOwnedHelpLogIds))); }
        catch (err) { console.warn('Could not persist cleared help log state:', err); }
      }
      renderOwnedPeerHelpRequests(Array.from(ownedHelpRequestState.values()));
      showToast('Help request log cleared from this window. Request records are unchanged.', 'success');
    }

    async function createPeerHelpRequest(question) {
      if (!signedInUser || !currentAssignmentId || currentSubmissionStatus !== 'in-progress' || requesterHelpLock) {
        showToast('You can request help while actively working on an assignment.', 'info');
        return;
      }
      const button = document.getElementById('createPeerHelpBtn');
      button.disabled = true;
      try {
        const requestsRef = db.collection('assignments').doc(currentAssignmentId).collection('helpRequests');
        const requestRef = requestsRef.doc();
        const workKey = `wk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
        const now = firebase.firestore.FieldValue.serverTimestamp();
        const requestedMode = isPeerHelpEnabled() ? 'peer' : 'teacher';
        let finalMode = requestedMode;
        const canvasData = exportCanvasJpeg();
        const commitRequest = async mode => {
          const batch = db.batch();
          batch.set(requestRef, {
            requestId: requestRef.id,
            question: question.trim().slice(0, 500),
            requestMode: mode,
            status: 'pending',
            slideIndex: currentSlideIndex,
            workKey,
            helperUid: null,
            createdAt: now,
            updatedAt: now
          });
          batch.set(db.collection('assignments').doc(currentAssignmentId).collection('helpRequestOwners').doc(requestRef.id), {
            requesterUid: signedInUser.uid,
            createdAt: now
          });
          batch.set(requestRef.collection('slides').doc(`slide_${currentSlideIndex}`), {
            canvasData,
            updatedAt: now
          });
          batch.set(peerHelpLockRef(workKey), { requestId: requestRef.id, workKey, status: 'pending', createdAt: now, updatedAt: now });
          batch.set(db.collection('assignments').doc(currentAssignmentId).collection('students').doc(signedInUser.uid), {
            activeHelpLockKey: workKey
          }, { merge: true });
          await batch.commit();
        };
        try {
          await commitRequest(requestedMode);
        } catch (err) {
          // If the teacher toggled Peer Help off while this student page was open,
          // safely fall back to a teacher-only request without adding a read.
          if (requestedMode !== 'peer') throw err;
          finalMode = 'teacher';
          await commitRequest('teacher');
        }
        document.getElementById('askForHelpModal').classList.add('hidden');
        document.getElementById('askForHelpForm').reset();
        showToast(finalMode === 'peer' ? 'Peer Help request sent. Your identity is hidden from other students.' : 'Teacher Help request sent.', 'success');
        startPeerHelpListeners();
      } catch (err) {
        console.error('Could not create Peer Help request:', err);
        showToast('Could not send help request: ' + err.message, 'error');
      } finally {
        button.disabled = false;
      }
    }

    async function claimPeerHelpRequest(requestId) {
      if (!signedInUser || currentSubmissionStatus !== 'completed' || activeHelpRequestId) return;
      try {
        const ref = peerHelpRequestRef(requestId);
        await db.runTransaction(async transaction => {
          const doc = await transaction.get(ref);
          if (!doc.exists || doc.data().status !== 'pending') throw new Error('This request has already been claimed.');
          const lockRef = peerHelpLockRef(doc.data().workKey);
          const lockDoc = await transaction.get(lockRef);
          if (!lockDoc.exists || lockDoc.data().status !== 'pending') throw new Error('This request is no longer available.');
          const now = firebase.firestore.FieldValue.serverTimestamp();
          transaction.update(ref, {
            status: 'helping',
            helperUid: signedInUser.uid,
            claimedAt: now,
            updatedAt: now
          });
          transaction.update(lockRef, { status: 'helping', helperUid: signedInUser.uid, updatedAt: now });
        });
        const snapshot = await ref.get();
        activeHelpRequestId = requestId;
        activeHelpRequestData = snapshot.data();
        activeHelpMode = 'helper';
        currentSlideIndex = Number(activeHelpRequestData.slideIndex || 0);
        watchActiveHelpSession(requestId);
        document.getElementById('workspaceSubtext').textContent = 'Helping anonymously • Use the locked rose-colour pen, then Submit Help';
        updatePeerHelpControls();
        setupSlideWorkspace();
        showToast('You are now helping a peer. Your annotation colour is locked.', 'success');
      } catch (err) {
        console.error('Could not claim Peer Help request:', err);
        showToast('Could not open help request: ' + err.message, 'error');
      }
    }

    async function claimPeerHelpRequestAsTeacher(requestId) {
      if (!signedInUser || currentUserRole !== 'teacher' || !currentAssignmentId || activeHelpRequestId) return;
      try {
        const ref = peerHelpRequestRef(requestId);
        const ownerRef = peerHelpOwnerRef(requestId);
        const ownerSnapshot = await ownerRef.get();
        if (!ownerSnapshot.exists || !ownerSnapshot.data().requesterUid) {
          throw new Error('The requester record could not be found.');
        }
        const requesterUid = ownerSnapshot.data().requesterUid;
        const now = firebase.firestore.FieldValue.serverTimestamp();
        await db.runTransaction(async transaction => {
          const requestDoc = await transaction.get(ref);
          if (!requestDoc.exists || requestDoc.data().status !== 'pending') {
            throw new Error('This request has already been claimed or closed.');
          }
          const lockRef = peerHelpLockRef(requestDoc.data().workKey);
          const lockDoc = await transaction.get(lockRef);
          if (!lockDoc.exists || lockDoc.data().status !== 'pending') {
            throw new Error('This request is no longer available.');
          }
          transaction.update(ref, {
            status: 'helping',
            helperUid: signedInUser.uid,
            claimedAt: now,
            updatedAt: now
          });
          transaction.update(lockRef, {
            status: 'helping',
            helperUid: signedInUser.uid,
            updatedAt: now
          });
        });
        const snapshot = await ref.get();
        activeHelpRequestId = requestId;
        activeHelpRequestData = snapshot.data();
        activeHelpMode = 'teacher';
        studentId = requesterUid;
        inspectingStudentId = requesterUid;
        currentSubmissionStatus = 'submitted';
        currentSlideIndex = Number(activeHelpRequestData.slideIndex || 0);
        // Open the same full workspace used by the teacher's normal "View Work" action.
        // Teacher annotations save directly to the requester's real slide document.
        window.currentInspectedStudentRecord = { studentUid: requesterUid, id: requesterUid, status: currentSubmissionStatus };
        stopStudentPreviewListeners();
        teacherDashboard.classList.add('hidden');
        studentJoinScreen.classList.add('hidden');
        studentHistoryScreen.classList.add('hidden');
        workspaceScreen.classList.remove('hidden');
        document.getElementById('exitWorkspaceBtn').classList.remove('hidden');
        document.getElementById('workspaceTitle').textContent = 'Helping student';
        document.getElementById('workspaceSubtext').textContent = "Teacher annotations live-sync to the student's canvas";
        document.getElementById('teacherReviewActions').classList.add('hidden');
        updateSubmitAssignmentButton();
        watchActiveHelpSession(requestId);
        updatePeerHelpControls();
        setupSlideWorkspace();
        // Reapply normal teacher annotation defaults after workspace setup.
        currentColor = '#dc2626';
        const picker = document.getElementById('colorPicker');
        if (picker) picker.value = currentColor;
        setTool('pen');
        updatePeerHelpControls();
        showToast('Student work opened with the full annotation toolbar.', 'success');
      } catch (err) {
        console.error('Could not open teacher Peer Help session:', err);
        showToast('Could not open help request: ' + err.message, 'error');
      }
    }

    async function saveActiveHelpCanvasNow() {
      if (!activeHelpRequestId || !['helper', 'teacher'].includes(activeHelpMode)) return;
      clearTimeout(saveTimeout);
      const dataUrl = exportCanvasJpeg();
      const now = firebase.firestore.FieldValue.serverTimestamp();
      if (activeHelpMode === 'teacher' && inspectingStudentId) {
        // Match the normal teacher "View Work" persistence path.
        await db.collection('assignments').doc(currentAssignmentId)
          .collection('students').doc(inspectingStudentId)
          .collection('slides').doc(`slide_${currentSlideIndex}`)
          .set({ canvasData: dataUrl, updatedAt: now, teacherAnnotatedAt: now, teacherAnnotatedBy: signedInUser?.uid || null }, { merge: true });
      } else {
        await db.collection('assignments').doc(currentAssignmentId).collection('helpRequests').doc(activeHelpRequestId)
          .collection('slides').doc(`slide_${currentSlideIndex}`)
          .set({ canvasData: dataUrl, updatedAt: now }, { merge: true });
      }
      if (activeHelpMode === 'helper') {
        await peerHelpRequestRef(activeHelpRequestId).update({ lastActivityAt: now, updatedAt: now });
      }
    }

    async function submitPeerHelp(requestId, asTeacher = false) {
      if (!signedInUser || !currentAssignmentId) return;
      const helperButton = document.getElementById('submitPeerHelpBtn');
      const teacherButton = document.getElementById('teacherSubmitPeerHelpBtn');
      if (helperButton) helperButton.disabled = true;
      if (teacherButton) teacherButton.disabled = true;
      try {
        if (!asTeacher || (activeHelpMode === 'teacher' && activeHelpRequestId === requestId)) {
          await saveActiveHelpCanvasNow();
        }
        const ref = peerHelpRequestRef(requestId);
        const now = firebase.firestore.FieldValue.serverTimestamp();
        if (asTeacher) {
          await db.runTransaction(async transaction => {
            const doc = await transaction.get(ref);
            if (!doc.exists || doc.data().status !== 'helping') throw new Error('This help session is no longer active.');
            const lockRef = peerHelpLockRef(doc.data().workKey);
            const lockDoc = await transaction.get(lockRef);
            if (!lockDoc.exists || lockDoc.data().status !== 'helping') throw new Error('The session lock is no longer active.');
            transaction.update(ref, {
              status: 'submitted',
              submittedAt: now,
              updatedAt: now,
              teacherSubmittedBy: signedInUser.uid,
              teacherSubmittedAt: now
            });
            transaction.update(lockRef, { status: 'submitted', updatedAt: now });
            transaction.set(db.collection('users').doc(signedInUser.uid).collection('peerHelpEvents').doc(`teacher_submitted_${requestId}`), {
              eventType: 'teacher-submitted-on-behalf',
              assignmentId: currentAssignmentId,
              requestId,
              helperUid: doc.data().helperUid,
              teacherUid: signedInUser.uid,
              createdAt: now
            });
          });
        } else {
          await db.runTransaction(async transaction => {
            const doc = await transaction.get(ref);
            if (!doc.exists || doc.data().status !== 'helping' || doc.data().helperUid !== signedInUser.uid) {
              throw new Error('You are no longer the assigned helper for this request.');
            }
            const lockRef = peerHelpLockRef(doc.data().workKey);
            const lockDoc = await transaction.get(lockRef);
            if (!lockDoc.exists || lockDoc.data().status !== 'helping') throw new Error('The session lock is no longer active.');
            transaction.update(ref, { status: 'submitted', submittedAt: now, updatedAt: now });
            transaction.update(lockRef, { status: 'submitted', updatedAt: now });
            transaction.set(db.collection('users').doc(signedInUser.uid).collection('peerHelpEvents').doc(`help_submitted_${requestId}`), {
              eventType: 'help-submitted',
              assignmentId: currentAssignmentId,
              requestId,
              helperUid: signedInUser.uid,
              createdAt: now
            });
          });
        }
        if (!asTeacher) {
          if (unsubActiveHelpSession) { unsubActiveHelpSession(); unsubActiveHelpSession = null; }
          activeHelpRequestId = null;
          activeHelpRequestData = null;
          activeHelpMode = null;
          updatePeerHelpControls();
          loadCurrentSlideData();
          document.getElementById('workspaceSubtext').textContent = 'Assignment workspace • Your own work remains unchanged';
        }
        showToast(asTeacher ? 'Help session submitted on behalf of the helper.' : 'Help submitted. The requester can now continue working.', 'success');
      } catch (err) {
        console.error('Could not submit Peer Help:', err);
        showToast('Could not submit help: ' + err.message, 'error');
      } finally {
        if (helperButton) helperButton.disabled = false;
        if (teacherButton) teacherButton.disabled = false;
      }
    }

    async function expirePeerHelpRequest(requestId) {
      if (!signedInUser || currentUserRole !== 'teacher') return;
      if (!confirm('Expire this help request? The requester will be able to continue working.')) return;
      try {
        const ref = peerHelpRequestRef(requestId);
        await db.runTransaction(async transaction => {
          const doc = await transaction.get(ref);
          if (!doc.exists || !['pending', 'helping'].includes(doc.data().status)) throw new Error('This request is no longer active.');
          const lockRef = peerHelpLockRef(doc.data().workKey);
          const lockDoc = await transaction.get(lockRef);
          const now = firebase.firestore.FieldValue.serverTimestamp();
          transaction.update(ref, { status: 'expired', expiredAt: now, updatedAt: now });
          if (lockDoc.exists) transaction.update(lockRef, { status: 'expired', updatedAt: now });
        });
        showToast('Peer Help request expired.', 'success');
      } catch (err) {
        showToast('Could not expire request: ' + err.message, 'error');
      }
    }

    function watchActiveHelpSession(requestId) {
      if (unsubActiveHelpSession) { unsubActiveHelpSession(); unsubActiveHelpSession = null; }
      if (!db || !requestId) return;
      unsubActiveHelpSession = peerHelpRequestRef(requestId).onSnapshot(snapshot => {
        if (!snapshot.exists || activeHelpRequestId !== requestId || !['helper', 'teacher'].includes(activeHelpMode)) return;
        const status = snapshot.data().status;
        if (status === 'helping') return;
        if (unsubActiveHelpSession) { unsubActiveHelpSession(); unsubActiveHelpSession = null; }
        isDrawing = false;
        activeHelpRequestId = null;
        activeHelpRequestData = null;
        activeHelpMode = null;
        updatePeerHelpControls();
        loadCurrentSlideData();
        if (status === 'submitted') {
          document.getElementById('workspaceSubtext').textContent = 'Help session finalised. Your own assignment canvas is restored.';
          showToast('The help session was finalised. Your annotation workspace is now read-only again.', 'info');
        } else if (status === 'expired') {
          document.getElementById('workspaceSubtext').textContent = 'Help session released by the teacher.';
          showToast('The teacher released this help session.', 'info');
        }
      }, err => console.warn('Active Peer Help session listener:', err));
    }

    function startTeacherHelpMonitor(assignmentId) {
      if (!db || !signedInUser || currentUserRole !== 'teacher' || !assignmentId) return;
      if (unsubTeacherHelpRequests && peerHelpListeningAssignmentId === assignmentId) return;
      if (unsubTeacherHelpRequests) { unsubTeacherHelpRequests(); unsubTeacherHelpRequests = null; }
      const assignmentRef = db.collection('assignments').doc(assignmentId);
      // Monitor actionable requests only and cache requester labels between snapshots.
      unsubTeacherHelpRequests = assignmentRef.collection('helpRequests')
        .where('status', 'in', ['pending', 'helping', 'submitted'])
        .limit(25)
        .onSnapshot(async snapshot => {
          const requests = await Promise.all(snapshot.docs.map(async d => {
            const data = { id: d.id, ...d.data() };
            if (teacherRequesterLabelCache.has(d.id)) {
              data.requesterLabel = teacherRequesterLabelCache.get(d.id);
              return data;
            }
            try {
              const owner = await assignmentRef.collection('helpRequestOwners').doc(d.id).get();
              let label = 'Student';
              if (owner.exists && owner.data().requesterUid) {
                const student = await assignmentRef.collection('students').doc(owner.data().requesterUid).get();
                label = student.exists ? (student.data().name || 'Student') : 'Student';
              }
              teacherRequesterLabelCache.set(d.id, label);
              data.requesterLabel = label;
            } catch (err) {
              console.warn('Could not resolve requester for teacher view:', err);
            }
            return data;
          }));
          renderPeerHelpRequests(requests, 'teacher');
        }, err => {
          console.warn('Teacher Peer Help monitor:', err);
          const target = document.getElementById('teacherPeerHelpList');
          if (target) target.innerHTML = '<p class="text-sm text-rose-600">Could not load Peer Help requests. Check Firestore rules.</p>';
        });
    }

    document.getElementById('askForHelpBtn').addEventListener('click', () => {
      document.getElementById('askForHelpTitle').textContent = isPeerHelpEnabled() ? 'Ask for Peer Help' : 'Ask your teacher for help';
      document.getElementById('createPeerHelpBtn').textContent = isPeerHelpEnabled() ? 'Send Peer Help request' : 'Send to Teacher';
      document.getElementById('askForHelpModal').classList.remove('hidden');
      document.getElementById('peerHelpQuestionInput').focus();
    });
    document.getElementById('closeAskForHelpBtn').addEventListener('click', () => document.getElementById('askForHelpModal').classList.add('hidden'));
    document.getElementById('cancelAskForHelpBtn').addEventListener('click', () => document.getElementById('askForHelpModal').classList.add('hidden'));
    document.getElementById('askForHelpForm').addEventListener('submit', event => {
      event.preventDefault();
      createPeerHelpRequest(document.getElementById('peerHelpQuestionInput').value);
    });
    document.getElementById('submitPeerHelpBtn').addEventListener('click', () => activeHelpRequestId && submitPeerHelp(activeHelpRequestId, false));
    document.getElementById('teacherSubmitPeerHelpBtn').addEventListener('click', () => activeHelpRequestId && submitPeerHelp(activeHelpRequestId, true));
    document.getElementById('refreshPeerHelpBtn').addEventListener('click', startPeerHelpListeners);
    document.getElementById('clearPeerHelpLogBtn').addEventListener('click', clearOwnedPeerHelpLog);
    document.getElementById('teacherRefreshPeerHelpBtn').addEventListener('click', () => startTeacherHelpMonitor(currentAssignmentId));

    // ==========================================
    // UTILITY & NOTIFICATION FUNCTIONS
    // ==========================================
    function showToast(message, type = "info") {
      const container = document.getElementById('toastContainer');
      const toast = document.createElement('div');

      const bgColors = {
        success: 'bg-emerald-600 text-white',
        error: 'bg-rose-600 text-white',
        info: 'bg-indigo-600 text-white'
      };

      toast.className = `${bgColors[type] || bgColors.info} px-4 py-3 rounded-lg shadow-lg flex items-center justify-between gap-3 text-sm font-medium transition-all duration-300 transform translate-y-2 opacity-100`;
      
      const iconClass = type === 'success' ? 'fa-check-circle' : (type === 'error' ? 'fa-exclamation-triangle' : 'fa-info-circle');
      
      toast.innerHTML = `
        <div class="flex items-center gap-2">
          <i class="fa-solid ${iconClass}"></i>
          <span>${escapeHtml(message)}</span>
        </div>
        <button type="button" class="text-white/80 hover:text-white font-bold text-lg leading-none">&times;</button>
      `;

      toast.querySelector('button').addEventListener('click', () => toast.remove());

      container.appendChild(toast);

      setTimeout(() => toast.classList.remove('translate-y-2'), 10);
      setTimeout(() => {
        toast.classList.add('opacity-0', 'translate-y-2');
        setTimeout(() => toast.remove(), 300);
      }, 4000);
    }

    function escapeHtml(str) {
      if (!str) return '';
      return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
    }
  
