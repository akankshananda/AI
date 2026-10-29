
let currentQuiz = null;

function getStarted() {
    window.location.href = "pages/dashboard.html";
}

function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, character => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[character]);
}

function renderMarkdown(value) {
    const cleaned = String(value || "").replace(/\\([#*_`~>-])/g, "$1");

    if (window.marked && window.DOMPurify) {
        return window.DOMPurify.sanitize(window.marked.parse(cleaned));
    }

    return escapeHTML(cleaned).replace(/\n/g, "<br>");
}

// ---------- Gemini API (called directly from the browser) ----------
const ANGLES = [
    "real-world applications", "common misconceptions", "definitions and terminology",
    "history and key figures", "problem solving and calculations", "cause and effect",
    "comparisons between related ideas", "exam-style tricky questions",
    "core principles", "advanced details", "practical examples"
];

// Random value + random angle so every response is different
function freshTag() {
    const id = Math.floor(100000 + Math.random() * 900000);
    const angle = ANGLES[Math.floor(Math.random() * ANGLES.length)];
    return `Variation ID: ${id}. Focus angle: ${angle}.`;
}

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

async function askGemini(prompt, asJSON = false) {
    if (typeof GEMINI_API_KEY === "undefined" || GEMINI_API_KEY === "YOUR_GEMINI_API_KEY") {
        throw new Error("API key missing. Open js/config.js and paste your Gemini API key.");
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

    async function send(useFastSettings) {
        const generationConfig = { temperature: 1.0 };
        if (asJSON) generationConfig.responseMimeType = "application/json"; // clean JSON, no retries
        if (useFastSettings) {
            // Gemini 3.x uses "thinkingLevel", Gemini 2.5 uses "thinkingBudget" (turns slow thinking down/off)
            generationConfig.thinkingConfig = /gemini-3/.test(GEMINI_MODEL)
                ? { thinkingLevel: "minimal" }
                : { thinkingBudget: 0 };
        }

        return fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": GEMINI_API_KEY
            },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig
            })
        });
    }

    let response;
    try {
        response = await send(true);
        // If this model does not accept the fast setting, retry without it
        if (response.status === 400) response = await send(false);
    } catch (error) {
        throw new Error("Cannot reach Gemini. Check your internet connection.");
    }

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error((data.error && data.error.message) || `Gemini error (HTTP ${response.status}).`);
    }

    const parts = data.candidates?.[0]?.content?.parts || [];
    const text = parts.map(p => p.text || "").join("").trim();

    if (!text) throw new Error("Gemini returned an empty response. Try again.");
    return text;
}

function parseJSON(text) {
    const cleaned = text
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "");
    return JSON.parse(cleaned);
}

// Same function name as before, so the rest of the code works unchanged.
async function postJSON(url, body) {
    if (url === "/api/study") {
        const topic = String(body.topic || "").slice(0, 200);
        const level = body.level || "Beginner";
        const notes = await askGemini(`Create clear academic study notes about: ${topic}
Student level: ${level}
${freshTag()} Use a fresh explanation and new examples each time.

Return Markdown with these sections:
# Study Notes: ${topic}
## 1. Introduction
## 2. Important Concepts
## 3. Key Points
## 4. Simple Examples
## 5. Short Summary

Keep it short and exam-focused (about 300-400 words). Use bullet points and bold important terms.
Do not escape Markdown punctuation with backslashes.`);
        return { topic, level, notes };
    }

    if (url === "/api/quiz") {
        const topic = String(body.topic || "").slice(0, 200);
        const count = Math.min(Math.max(Number(body.count) || 5, 1), 15);
        const difficulty = ["easy", "medium", "hard"].includes(body.difficulty) ? body.difficulty : "easy";

        const text = await askGemini(`Create exactly ${count} NEW and DIFFERENT multiple-choice questions about ${topic}.
Difficulty: ${difficulty}. ${freshTag()}
Do not repeat common textbook questions; vary the style and subtopics.
Return ONLY valid JSON in this structure:
{"questions": [{"question": "text", "options": ["A", "B", "C", "D"], "answer": 0, "explanation": "short explanation"}]}
"answer" is a zero-based integer 0-3. Each question has exactly four options.
No Markdown fences and no text outside the JSON.`, true);

        let items;
        try {
            items = parseJSON(text).questions || [];
        } catch (e) {
            throw new Error("AI returned an invalid quiz. Please click Generate Quiz again.");
        }

        const questions = items.slice(0, count)
            .filter(q => q && typeof q.question === "string" && Array.isArray(q.options)
                && q.options.length === 4 && Number.isInteger(q.answer) && q.answer >= 0 && q.answer <= 3)
            .map(q => {
                const options = q.options.map(String);
                const correct = options[q.answer];
                shuffle(options); // correct answer goes to a random position
                return {
                    question: q.question,
                    options,
                    answer: options.indexOf(correct),
                    explanation: String(q.explanation || "")
                };
            });

        if (questions.length === 0) throw new Error("No valid questions returned. Please try again.");
        return { topic, difficulty, questions };
    }

    if (url === "/api/writing") {
        const actions = {
            improve: "Improve clarity, flow, and academic style while preserving the meaning.",
            grammar: "Correct grammar, spelling, and punctuation while preserving the original meaning.",
            summarize: "Summarize the text, preserving its most important ideas.",
            formal: "Rewrite the text in a professional, formal academic tone.",
            expand: "Expand the text with relevant detail while preserving its original meaning."
        };
        const action = actions[body.action] ? body.action : "improve";
        const result = await askGemini(`Perform this writing task: ${actions[action]}
Return only the revised text, with Markdown formatting if useful.
Text:
${String(body.text || "").slice(0, 12000)}`);
        return { action, result };
    }

    if (url === "/api/chat") {
        const answer = await askGemini(`You are ExamForge, a friendly academic study assistant.
Answer clearly and accurately in simple language, using headings and bullets when useful.
If the question is ambiguous, briefly explain your assumption.

Student question:
${String(body.message || "").slice(0, 8000)}`);
        return { answer };
    }

    throw new Error("Unknown request: " + url);
}

async function generateNotes() {
    const topic = document.getElementById("study-topic").value.trim();
    const level = document.getElementById("study-level").value;
    const result = document.getElementById("notes-result");

    if (!topic) {
        result.textContent = "Please enter an academic topic.";
        return;
    }

    result.innerHTML =
        "<h2>Generating study notes...</h2>" +
        "<p>Please wait while ExamForge creates your notes.</p>";

    try {
        const data = await postJSON("/api/study", { topic, level });

        result.innerHTML = `
            <h2>${escapeHTML(data.topic)}</h2>
            <p class="result-meta"><strong>Level:</strong> ${escapeHTML(data.level)}</p>
            <div class="markdown-content">${renderMarkdown(data.notes)}</div>
        `;
    } catch (error) {
        result.textContent = error.message;
    }
}

async function generateQuiz() {
    const topic = document.getElementById("quiz-topic").value.trim();
    const count = Number(document.getElementById("question-count").value);
    const difficulty = document.getElementById("quiz-difficulty").value;
    const result = document.getElementById("quiz-result");

    if (!topic) {
        result.textContent = "Please enter a topic to generate your quiz.";
        return;
    }

    result.textContent = "Generating your quiz. This may take a moment.";

    try {
        const data = await postJSON("/api/quiz", {
            topic,
            count,
            difficulty
        });

        if (!Array.isArray(data.questions) || data.questions.length === 0) {
            throw new Error("The backend did not return any quiz questions.");
        }

        currentQuiz = {
            topic: data.topic,
            difficulty: data.difficulty,
            questions: data.questions
        };

        result.innerHTML = `
            <h2>${escapeHTML(data.topic)} Quiz</h2>
            <p>${data.questions.length} questions · Difficulty: ${escapeHTML(data.difficulty)}</p>
            <form id="quiz-form">
                ${data.questions.map((question, index) => `
                    <fieldset class="quiz-question">
                        <legend>${index + 1}. ${escapeHTML(question.question)}</legend>
                        ${question.options.map((option, optionIndex) => `
                            <label class="quiz-option">
                                <input
                                    type="radio"
                                    name="question-${index}"
                                    value="${optionIndex}"
                                    required
                                >
                                ${escapeHTML(option)}
                            </label>
                        `).join("")}
                    </fieldset>
                `).join("")}
                <button type="submit">Submit Quiz</button>
            </form>
            <div id="quiz-score" aria-live="polite"></div>
        `;

        document
            .getElementById("quiz-form")
            .addEventListener("submit", submitQuiz);

    } catch (error) {
        result.textContent = error.message;
    }
}

async function submitQuiz(event) {
    event.preventDefault();

    if (!currentQuiz) return;

    const formData = new FormData(event.currentTarget);
    let score = 0;

    const review = currentQuiz.questions.map((question, index) => {
        const selected = Number(formData.get(`question-${index}`));
        const correct = selected === question.answer;

        if (correct) score += 1;

        return `
            <div class="quiz-review">
                <p><strong>${index + 1}. ${escapeHTML(question.question)}</strong></p>
                <p>
                    ${correct
                        ? "Correct"
                        : `Correct answer: ${escapeHTML(question.options[question.answer])}`}
                </p>
                ${question.explanation
                    ? `<p>${escapeHTML(question.explanation)}</p>`
                    : ""}
            </div>
        `;
    }).join("");

    const scoreElement = document.getElementById("quiz-score");

    scoreElement.innerHTML = `
        <h3>Your score: ${score}/${currentQuiz.questions.length}</h3>
        ${review}
    `;

    // Keep simple stats in the browser (no database needed)
    try {
        const history = JSON.parse(localStorage.getItem("quizHistory") || "[]");
        history.push({
            topic: currentQuiz.topic,
            score,
            total: currentQuiz.questions.length
        });
        localStorage.setItem("quizHistory", JSON.stringify(history));
    } catch (e) {}
}

function loadDashboardStats() {
    const box = document.getElementById("dashboard-stats");
    if (!box) return;
    let history = [];
    try { history = JSON.parse(localStorage.getItem("quizHistory") || "[]"); } catch (e) {}
    const best = history.length
        ? Math.max(...history.map(h => Math.round(h.score / h.total * 100))) + "%"
        : "-";
    const last = history.length ? history[history.length - 1] : null;
    box.innerHTML = `
        <div class="stat-card"><h3>Quizzes Taken</h3><p>${history.length}</p></div>
        <div class="stat-card"><h3>Best Score</h3><p>${best}</p></div>
        <div class="stat-card"><h3>Last Quiz</h3><p>${last ? last.score + "/" + last.total : "-"}</p></div>
    `;
}
document.addEventListener("DOMContentLoaded", loadDashboardStats);

async function processWriting() {
    const text = document.getElementById("writing-text").value.trim();
    const action = document.getElementById("writing-action").value;
    const result = document.getElementById("writing-result");

    if (!text) {
        result.textContent = "Please enter some text before processing.";
        return;
    }

    result.textContent = "Working on your text...";

    try {
        const data = await postJSON("/api/writing", { text, action });

        result.innerHTML = `
            <h2>Writing Result</h2>
            <p class="result-meta">Action: ${escapeHTML(data.action)}</p>
            <div class="markdown-content">${renderMarkdown(data.result)}</div>
        `;
    } catch (error) {
        result.textContent = error.message;
    }
}

async function sendMessage() {
    const input = document.getElementById("chat-input");
    const messages = document.getElementById("chat-messages");
    const message = input.value.trim();

    if (!message) return;

    const userBubble = document.createElement("div");
    userBubble.className = "message user-message";
    userBubble.textContent = message;
    messages.appendChild(userBubble);

    input.value = "";

    const loadingBubble = document.createElement("div");
    loadingBubble.className = "message ai-message";
    loadingBubble.textContent = "Thinking...";
    messages.appendChild(loadingBubble);

    messages.scrollTop = messages.scrollHeight;

    try {
        const data = await postJSON("/api/chat", { message });
        loadingBubble.innerHTML = renderMarkdown(data.answer);
    } catch (error) {
        loadingBubble.textContent = error.message;
    }

    messages.scrollTop = messages.scrollHeight;
}

function handleChatKey(event) {
    if (event.key === "Enter") {
        event.preventDefault();
        sendMessage();
    }
}

