import React, {
    useState,
    useEffect,
    useCallback,
    useRef,
    useContext,
} from "react";
import {useLocation, useParams} from "react-router";
import {
    Row,
    Col, Card, Button,
} from "react-bootstrap";
import ReactPlayer from "react-player";
import Peer, {DataConnection} from "peerjs";

import AppContext from "../AppContext.tsx";
import QuestionCard from "../components/quiz/QuestionCard.tsx";
import QuizInfoCard from "../components/quiz/QuizInfoCard.tsx";
import {Question, Quiz, Reoccurrence} from "../components/quiz/types.ts";
import ContinuityModal from "../components/quiz/ContinuityModal.tsx";
import {getDeviceFriendlyName, getDeviceType} from "../components/quiz/helpers/deviceUtils.ts";
import {Icon} from "@iconify/react";

import "../styles/quiz.css";
import PropagateLoader from "react-spinners/PropagateLoader";
import LoginPrompt from "../components/LoginPrompt.tsx";
import {AxiosError} from "axios";
import QuizActionButtons from "../components/quiz/QuizActionButtons.tsx";
import {toast} from "react-toastify";

interface UserSettings {
    sync_progress: boolean;
    initial_reoccurrences: number;
    wrong_answer_reoccurrences: number;
}

interface Progress {
    current_question: number;
    correct_answers_count: number;
    wrong_answers_count: number;
    study_time: number;
    last_activity?: string;
    reoccurrences: Reoccurrence[];
}


const PING_INTERVAL = 5000; // 5s
const PING_TIMEOUT = 15000; // 15s


/**
 * Main QuizPage component
 */
const QuizPage: React.FC = () => {
    const {quizId} = useParams<{ quizId: string }>();
    const appContext = useContext(AppContext);
    const location = useLocation();
    const queryParams = new URLSearchParams(location.search);

    // ========== States ==========
    // Basic
    const [loading, setLoading] = useState(true);
    const [quiz, setQuiz] = useState<Quiz | null>(null);
    const [userSettings, setUserSettings] = useState<UserSettings>({
        sync_progress: false,
        initial_reoccurrences: 1,
        wrong_answer_reoccurrences: 1,
    });

    // Question management
    const [reoccurrences, setReoccurrences] = useState<Reoccurrence[]>([]);
    const [currentQuestion, setCurrentQuestion] = useState<Question | null>(null);
    const [selectedAnswers, setSelectedAnswers] = useState<number[]>([]);
    const [questionChecked, setQuestionChecked] = useState(false);

    // Stats
    const [correctAnswersCount, setCorrectAnswersCount] = useState(0);
    const [wrongAnswersCount, setWrongAnswersCount] = useState(0);
    const [isQuizFinished, setIsQuizFinished] = useState(false);
    const [studyTime, setStudyTime] = useState(0);

    // Timers
    const timerRef = useRef<number | null>(null);
    const startTimeRef = useRef<number>(Date.now());

    // Continuity
    const [peerConnections, setPeerConnections] = useState<DataConnection[]>([]);
    const [isContinuityHost, setIsContinuityHost] = useState(false);
    const hasInitializedContinuity = useRef(false);

    // Refs for use in Continuity callbacks
    const currentQuestionRef = useRef<Question | null>(null);
    const reoccurrencesRef = useRef<Reoccurrence[]>([]);
    const wrongAnswersCountRef = useRef<number>(0);
    const correctAnswersCountRef = useRef<number>(0);
    const peerRef = useRef<Peer | null>(null);

    // Memes
    const [showBrainrot, setShowBrainrot] = useState(false);


    // ========== Lifecycle ==========
    useEffect(() => {
        if (queryParams.get("error") === "not_student") {
            toast.error("Nie udało się nam potwierdzić, że jesteś studentem. Spróbuj ponownie.");
            window.history.replaceState({}, document.title, window.location.pathname);
        }

        (async () => {
            const quizData = await fetchQuiz();
            if (!quizData) {
                console.error("Quiz not found or error fetching.");
                setLoading(false);
                return;
            }
            setQuiz(quizData);

            document.title = `${quizData.title} - Testownik Solvro`;

            // Handle version update logic
            handleVersionUpdate(quizData.version);

            const settings = await fetchUserSettings();
            if (settings.sync_progress && !hasInitializedContinuity.current) {
                // Initialize the continuity (PeerJS)
                initiateContinuity();
                hasInitializedContinuity.current = true;
            }
            setUserSettings(settings);

            // Attempt to load progress
            const savedProgress = await loadProgress(settings.sync_progress);
            if (savedProgress && savedProgress.current_question !== 0) {
                applyLoadedProgress(quizData, savedProgress);
            } else {
                // If no progress, create fresh reoccurrences & pick random question
                console.log(quizData)
                const newReoccurrences = quizData.questions.map((q) => ({
                    id: q.id,
                    reoccurrences: settings.initial_reoccurrences,
                }));
                setReoccurrences(newReoccurrences);
                pickRandomQuestion(quizData, newReoccurrences);
            }

            setLoading(false);
        })();


        // Key press handler

        // Ping interval
        const pingIntervalId = setInterval(() => {
            pingPeers();
        }, PING_INTERVAL);

        // Start timer for studyTime
        timerRef.current = window.setInterval(() => {
            updateStudyTime();
        }, 1000);

        // Cleanup
        return () => {
            clearInterval(pingIntervalId);
            if (timerRef.current) clearInterval(timerRef.current);
            gracefullyClosePeerConnection();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [appContext.isAuthenticated]);

    // Whenever currentQuestion changes, we attempt to save progress
    useEffect(() => {
        if (currentQuestion) {
            saveProgress();
        }
        currentQuestionRef.current = currentQuestion;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentQuestion]);


    useEffect(() => {
        reoccurrencesRef.current = reoccurrences;
    }, [reoccurrences]);

    useEffect(() => {
        wrongAnswersCountRef.current = wrongAnswersCount;
    }, [wrongAnswersCount]);

    useEffect(() => {
        correctAnswersCountRef.current = correctAnswersCount;
    }, [correctAnswersCount]);

    // ========== API & Local Storage Helpers ==========
    const fetchQuiz = async (): Promise<Quiz | null> => {
        try {
            const response = await appContext.axiosInstance.get(`/quizzes/${quizId}/`);
            if (response.status === 200) {
                return response.data;
            }
        } catch (e) {
            console.error("Error fetching quiz:", e);
        }
        return null;
    };

    const fetchUserSettings = async (): Promise<UserSettings> => {
        try {
            const response = await appContext.axiosInstance.get("/settings/");
            if (response.status === 200) {
                return response.data;
            }
        } catch (e) {
            console.error("Error fetching user settings:", e);
        }
        return {
            sync_progress: false,
            initial_reoccurrences: 1,
            wrong_answer_reoccurrences: 1,
        };
    };

    const loadProgress = async (sync: boolean): Promise<Progress | null> => {
        // Try server if sync is enabled
        if (sync) {
            try {
                const response = await appContext.axiosInstance.get(
                    `/quiz-progress/${quizId}/`
                );
                if (response.status === 200) {
                    startTimeRef.current = Date.now() - response.data.study_time * 1000;
                    return response.data;
                }
            } catch (e) {
                console.log("No server progress found or error retrieving. Falling back. Error:", e);
            }
        }
        // Fallback to local storage
        const stored = localStorage.getItem(`${quizId}_progress`);
        const parsed = stored ? JSON.parse(stored) : null;
        if (parsed) {
            startTimeRef.current = Date.now() - parsed.study_time * 1000;
        }
        return parsed;
    };

    const saveProgress = useCallback(async () => {
        if (!currentQuestion || isQuizFinished) return;

        const progress: Progress = {
            current_question: currentQuestion.id,
            correct_answers_count: correctAnswersCount,
            wrong_answers_count: wrongAnswersCount,
            study_time: studyTime,
            reoccurrences: reoccurrences,
        };

        // localStorage
        localStorage.setItem(`${quizId}_progress`, JSON.stringify(progress));

        // if sync and either we are host or not connected at all
        if (
            userSettings.sync_progress &&
            (isContinuityHost || peerConnections.length === 0)
        ) {
            try {
                await appContext.axiosInstance.post(`/quiz-progress/${quizId}/`, progress);
            } catch (e) {
                console.error("Error saving progress to server:", e);
            }
        }
    }, [
        currentQuestion,
        correctAnswersCount,
        wrongAnswersCount,
        studyTime,
        reoccurrences,
        isQuizFinished,
        isContinuityHost,
        peerConnections,
        quizId,
        userSettings.sync_progress,
        appContext.axiosInstance,
    ]);

    const resetProgress = async () => {
        localStorage.removeItem(`${quizId}_progress`);
        if (userSettings.sync_progress) {
            try {
                await appContext.axiosInstance.delete(`/quiz-progress/${quizId}/`);
            } catch (e) {
                console.error("Error resetting progress on server:", e);
            }
        }
        // Now re-initialize states
        if (quiz) {
            const newReoccurrences = quiz.questions.map((q) => ({
                id: q.id,
                reoccurrences: userSettings.initial_reoccurrences,
            }));
            setReoccurrences(newReoccurrences);
            setCorrectAnswersCount(0);
            setWrongAnswersCount(0);
            setIsQuizFinished(false);
            setStudyTime(0);
            startTimeRef.current = Date.now();
            pickRandomQuestion(quiz, newReoccurrences);
        }
    };

    // ========== Version Checking ==========
    const handleVersionUpdate = (fetchedVersion: number) => {
        const localVersionKey = `${quizId}_version`;
        const storedVersionString = localStorage.getItem(localVersionKey);
        const storedVersion = storedVersionString ? parseInt(storedVersionString) : 0;

        if (!storedVersionString) {
            // No local version set yet
            localStorage.setItem(localVersionKey, fetchedVersion.toString());
        } else if (fetchedVersion !== storedVersion) {
            // Show a quick alert or set a special toast that DB updated
            console.log("Quiz został zaktualizowany!");
            localStorage.setItem(localVersionKey, fetchedVersion.toString());
        }
    };

    // ========== Question Handling ==========
    const applyLoadedProgress = (
        quizData: Quiz,
        savedProgress: Progress
    ): void => {
        // Reconstruct
        setCorrectAnswersCount(savedProgress.correct_answers_count);
        setWrongAnswersCount(savedProgress.wrong_answers_count);
        setReoccurrences(savedProgress.reoccurrences);
        setStudyTime(savedProgress.study_time);

        // If everything is mastered, or no question set, pick random
        const questionFromProgress = quizData.questions.find(
            (q) => q.id === savedProgress.current_question
        );
        if (!questionFromProgress) {
            pickRandomQuestion(quizData, savedProgress.reoccurrences);
        } else {
            const sortedAnswers = [...questionFromProgress.answers].sort(
                () => Math.random() - 0.5
            );
            setCurrentQuestion({...questionFromProgress, answers: sortedAnswers});
            // Check if everything is done
            const anyWithReoccurrences = savedProgress.reoccurrences.some(
                (r) => r.reoccurrences > 0
            );
            if (!anyWithReoccurrences) {
                setIsQuizFinished(true);
            }
        }
    };

    const pickRandomQuestion = (
        quizData: Quiz,
        recurrencesData: Reoccurrence[]
    ) => {
        const available = recurrencesData.filter((r) => r.reoccurrences > 0);
        if (available.length === 0) {
            setIsQuizFinished(true);
            saveProgress();
            setCurrentQuestion(null);
            return;
        }
        const randId = available[Math.floor(Math.random() * available.length)].id;
        const questionObj = quizData.questions.find((q) => q.id === randId);
        if (!questionObj) {
            setCurrentQuestion(null);
            return;
        }
        const sortedAnswers = [...questionObj.answers].sort(
            () => Math.random() - 0.5
        );
        setCurrentQuestion({...questionObj, answers: sortedAnswers});
        setIsQuizFinished(false);
        return {...questionObj, answers: sortedAnswers};
    };

    // use callback to avoid re-creating the function on every render
    const checkAnswer = (remote = false): void => {
        if (questionChecked || !currentQuestionRef.current) return;

        // If question has multiple correct answers, user might have multiple selected
        // We'll interpret correctness similarly to old code:
        // i.e. the question is correct if every correct answer is checked
        // and no incorrect answers are checked.
        const correctIndices = currentQuestionRef.current.answers
            .map((ans, idx) => (ans.correct ? idx : -1))
            .filter((idx) => idx !== -1);

        const isCorrect =
            correctIndices.length === selectedAnswers.length &&
            correctIndices.every((ci) => selectedAnswers.includes(ci));

        if (isCorrect) {
            setCorrectAnswersCount((count) => count + 1);
            // Decrement reoccurrences for this question
            setReoccurrences((prev) =>
                prev.map((r) =>
                    r.id === currentQuestionRef.current?.id
                        ? {...r, reoccurrences: Math.max(r.reoccurrences - 1, 0)}
                        : r
                )
            );
        } else {
            setWrongAnswersCount((count) => count + 1);
            // Increase reoccurrences if wrong
            setReoccurrences((prev) =>
                prev.map((r) =>
                    r.id === currentQuestionRef.current?.id
                        ? {
                            ...r,
                            reoccurrences:
                                r.reoccurrences + userSettings.wrong_answer_reoccurrences,
                        }
                        : r
                )
            );
        }

        setQuestionChecked(true);

        if (!remote) {
            // Broadcast to peers if needed
            sendToAllPeers({type: "answer_checked"});
        }
    };

    const nextQuestion = (): void => {
        if (!quiz) return;
        const newQuestion = pickRandomQuestion(quiz, reoccurrences);
        setSelectedAnswers([]);
        setQuestionChecked(false);
        if (newQuestion) {
            sendToAllPeers({type: "question_update", question: newQuestion, selectedAnswers: []});
        }
    };

    const nextAction = (): void => {
        if (questionChecked) {
            nextQuestion();
        } else {
            checkAnswer();
        }
    };

    // ========== Study time ==========
    const updateStudyTime = useCallback(() => {
        const diff = Math.floor((Date.now() - startTimeRef.current) / 1000);
        setStudyTime(diff);
    }, []);

    // ========== KeyPress Handling ==========
    const handleKeyPress = useCallback((event: globalThis.KeyboardEvent): void => {
        // Don’t override user typing in text input (except checkboxes).
        const target = event.target as HTMLElement;
        if (
            target.tagName.toLowerCase() === "input" &&
            (target as HTMLInputElement).type !== "checkbox"
        ) {
            return;
        }
        const key = event.key.toLowerCase();

        switch (key) {
            case "enter":
                if (target.tagName.toLowerCase() !== "button") {
                    nextAction();
                }
                break;
            case "s":
                nextQuestion();
                break;
            case "c":
                if (!event.ctrlKey) {
                    // no direct DOM manipulation; if you want to show the button forcibly,
                    // you can either unify it with state or let the user open the modal.
                    // We can do something like “setShowContinuity(true)” if you had a state
                    // for that. Or do nothing if the user specifically wants that logic.
                    // This is demonstration only:
                    // ...
                }
                break;
            default:
                break;
        }
    }, [nextAction, nextQuestion]);

    useEffect(() => {
        const keyDownHandler = (event: globalThis.KeyboardEvent) => {
            handleKeyPress(event);
        };
        window.addEventListener("keydown", keyDownHandler);
        return () => {
            window.removeEventListener("keydown", keyDownHandler);
        };
    }, [handleKeyPress]);

    // ========== Utility Actions (copy, chatgpt, report) ==========
    const copyToClipboard = (): void => {
        try {
            if (!currentQuestion) return;
            const {question, answers} = currentQuestion;
            const answersText = answers
                .map(
                    (answer, idx) =>
                        `Odpowiedź ${idx + 1}: ${answer.answer} (Poprawna: ${
                            answer.correct ? "Tak" : "Nie"
                        })`
                )
                .join("\n");
            const fullText = `${question}\n\n${answersText}`;
            navigator.clipboard.writeText(fullText).then(() => {
                toast.info("Pytanie skopiowane do schowka!")
            });
        } catch (error) {
            console.error("Błąd podczas kopiowania do schowka:", error);
            toast.error("Błąd podczas kopiowania do schowka!");
        }
    };

    const openInChatGPT = () => {
        try {
            if (!currentQuestion) return;
            const {question, answers} = currentQuestion;
            const answersText = answers
                .map(
                    (answer, idx) =>
                        `Odpowiedź ${idx + 1}: ${answer.answer} (Poprawna: ${
                            answer.correct ? "Tak" : "Nie"
                        })`
                )
                .join("\n");
            const fullText = `Wyjaśnij to pytanie i jak dojść do odpowiedzi: ${question}\n\nOdpowiedzi:\n${answersText}`;
            const chatGPTUrl = `https://chat.openai.com/?q=${encodeURIComponent(
                fullText
            )}`;
            window.open(chatGPTUrl, "_blank");
        } catch (error) {
            console.error("Error opening in ChatGPT:", error);
            toast.error("Błąd podczas otwierania w ChatGPT!");
        }
    };

    const reportIncorrectQuestion = async () => {
        if (!currentQuestion || !quiz) {
            alert("Brak pytania do zgłoszenia!");
            return;
        }
        if (!quiz) {
            alert("Quiz nie został załadowany, spróbuj ponownie później");
            return;
        }

        const issue = prompt("Podaj krótki opis błędu w pytaniu:");

        if (!issue) {
            alert("Nie podano opisu błędu, zgłoszenie nie zostało wysłane.");
            return;
        }

        try {
            const response = await appContext.axiosInstance.post("/report-quiz-error/", {
                quiz_id: quiz.id,
                question_id: currentQuestion.id,
                issue: issue,
            });

            if (response.status === 201) {
                alert("Zgłoszenie zostało wysłane do właściciela quizu. Dziękujemy!");
            } else {
                alert("Wystąpił błąd podczas wysyłania zgłoszenia. Spróbuj ponownie później. \n" + response.data);
            }
        } catch (e) {
            console.error("Error reporting incorrect question:", e);
            if (e instanceof AxiosError) {
                alert("Wystąpił błąd podczas wysyłania zgłoszenia. Spróbuj ponownie później. \n" + e.response?.data.error);
            } else {
                alert("Wystąpił błąd podczas wysyłania zgłoszenia. Spróbuj ponownie później.");
            }
        }

    };


    interface InitialSyncMessage {
        type: "initial_sync";
        startTime: number;
        correctAnswersCount: number;
        wrongAnswersCount: number;
        reoccurrences: Reoccurrence[];
    }

    interface QuestionUpdateMessage {
        type: "question_update";
        question: Question;
        selectedAnswers: number[];
    }

    interface AnswerCheckedMessage {
        type: "answer_checked";
    }

    interface PingMessage {
        type: "ping";
    }

    interface PongMessage {
        type: "pong";
    }

    type PeerMessage =
        | InitialSyncMessage
        | QuestionUpdateMessage
        | AnswerCheckedMessage
        | PingMessage
        | PongMessage;

    const initiateContinuity = () => {

        if (peerRef.current) {
            console.warn("Continuity already initialized");
            return;
        }

        const userId = localStorage.getItem("user_id");
        if (!userId) {
            console.warn("User ID not found, cannot create Peer.");
            return;
        }

        const baseId = `${quizId}_${userId}`.replace(/\//g, "");
        try {
            const hostPeer = new Peer(baseId, {
                config: {
                    iceServers: [
                        {urls: "stun:stun.l.google.com:19302"},
                        {urls: "stun:stun1.l.google.com:19302"},
                        {
                            urls: "turn:freestun.net:3478",
                            username: "free",
                            credential: "free",
                        },
                    ],
                },
            });

            hostPeer.on("open", (id) => {
                console.log("Peer opened with ID:", id);
                peerRef.current = hostPeer;
                setIsContinuityHost(true);
            });

            hostPeer.on("error", (err) => {
                if (err.type === "unavailable-id") {
                    console.info("Unavailable ID, becoming client and connecting to host...");
                    setIsContinuityHost(false);

                    const clientPeer = new Peer({
                        config: {
                            iceServers: [
                                {urls: "stun:stun.l.google.com:19302"},
                                {urls: "stun:stun1.l.google.com:19302"},
                                {
                                    urls: "turn:freestun.net:3478",
                                    username: "free",
                                    credential: "free",
                                },
                            ],
                        },
                    });

                    clientPeer.on("open", () => {
                        peerRef.current = clientPeer;
                        connectToPeer(clientPeer, baseId)
                            .then((conn) => {
                                toast.info("🖥️ Połączono z hostem!");
                                handlePeerConnectionAsClient(conn);
                            })
                            .catch((error) => {
                                console.error("Error connecting to host:", error);
                                alert("Failed to connect to the host. Please try again.");
                            });
                    });

                    clientPeer.on("error", (err2) => {
                        console.error("Client peer error:", err2);
                    });

                    clientPeer.on("connection", handlePeerConnectionAsClient);
                } else {
                    console.error("Peer error:", err);
                }
            });

            hostPeer.on("connection", handlePeerConnectionAsHost);
        } catch (e) {
            console.error("Error creating peer:", e);
        }
    };

    const connectToPeer = (thePeer: Peer, peerId: string) => {
        return new Promise<DataConnection>((resolve, reject) => {
            if (thePeer.open) {
                doConnect();
            } else {
                thePeer.on("open", doConnect);
                thePeer.on("error", reject);
            }

            function doConnect() {
                const conn = thePeer.connect(peerId, {
                    metadata: {
                        device: getDeviceFriendlyName(),
                        type: getDeviceType(),
                    },
                });
                conn.on("open", () => {
                    setPeerConnections((prev) => [...prev, conn]);
                    resolve(conn);
                });
                conn.on("error", reject);
            }
        });
    };

    const handlePeerConnectionAsHost = (conn: DataConnection) => {
        console.log("New client connected:", conn.peer);
        setPeerConnections((prev) => [...prev, conn]);

        conn.on("open", () => {
            const currentQuestion = currentQuestionRef.current;
            const reoccurrences = reoccurrencesRef.current;
            const wrongAnswersCount = wrongAnswersCountRef.current;
            const correctAnswersCount = correctAnswersCountRef.current;

            if (currentQuestion) {
                initialSyncToPeer(conn, currentQuestion, reoccurrences, startTimeRef.current, wrongAnswersCount, correctAnswersCount);
            } else {
                console.warn("No current question available for sync.");
            }
        });

        conn.on("data", (data) => {
            handlePeerDataAsHost(conn, data as PeerMessage);
        });

        conn.on("error", (err) => {
            console.error("Peer connection error:", err);
        });

        conn.on("close", () => handlePeerClose(conn));
    };

    const handlePeerDataAsHost = (conn: DataConnection, data: PeerMessage) => {

        switch (data.type) {
            case "question_update":
                // Update host state based on client's changes
                setCurrentQuestion(data.question);
                setQuestionChecked(false);
                setSelectedAnswers(data.selectedAnswers);

                // Relay changes to other clients
                sendToAllPeersExcept(conn, {
                    type: "question_update",
                    question: data.question,
                    selectedAnswers: data.selectedAnswers,
                });
                break;
            case "answer_checked":
                checkAnswer(true);
                // Relay answer checked to other clients
                sendToAllPeersExcept(conn, {type: "answer_checked"});
                break;
            case "ping":
                sendToPeer(conn, {type: "pong"});
                break;
            default:
                console.warn("Unknown message type from client:", data.type);
        }
    };

    const handlePeerClose = (conn: DataConnection) => {
        console.log("Peer disconnected:", conn.peer);
        setPeerConnections((prev) => prev.filter((c) => c.open && c.peer !== conn.peer));
        toast.info("🖥️ Klient rozłączony.");

        // If we are not the host, try to reconnect or if the host is no longer available then we can attempt to become the host
        if (!isContinuityHost && peerRef.current && !peerRef.current.destroyed) {
            connectToPeer(peerRef.current, conn.peer)
                .then((newConn) => {
                    handlePeerConnectionAsClient(newConn);
                })
                .catch(() => {
                    console.warn("Host is no longer available, attempting to become the host...");
                    initiateContinuity();
                });
        } else {
            console.warn("Host disconnected, attempting to become the host...");
            initiateContinuity();
        }
    };

    const handlePeerConnectionAsClient = (conn: DataConnection) => {

        conn.on("data", (data) => {
            handlePeerDataAsClient(data as PeerMessage);
        });

        conn.on("error", (err) => {
            console.error("Peer connection error:", err);
        });

        conn.on("close", () => handlePeerClose(conn));
    };

    const handlePeerDataAsClient = (data: PeerMessage) => {
        switch (data.type) {
            case "initial_sync":
                startTimeRef.current = data.startTime;
                setCorrectAnswersCount(data.correctAnswersCount);
                setWrongAnswersCount(data.wrongAnswersCount);
                setReoccurrences(data.reoccurrences);
                break;

            case "question_update":
                setCurrentQuestion(data.question);
                setQuestionChecked(false);
                setSelectedAnswers(data.selectedAnswers);
                break;

            case "answer_checked":
                checkAnswer(true);
                break;

            case "ping":
                sendToPeer(peerConnections[0], {type: "pong"});
                break;

            default:
                console.warn("Unknown message type from host:", data.type);
        }
    };

    const pingPeers = () => {
        peerConnections.forEach((conn) => {
            if (conn.open) {
                sendToPeer(conn, {type: "ping"});
                const timeout = setTimeout(() => {
                    console.warn("Ping timeout, closing connection:", conn.peer);
                    conn.close();
                }, PING_TIMEOUT);
                conn.on("data", (data) => {
                    const message = data as PeerMessage;
                    if (message.type === "pong") {
                        clearTimeout(timeout);
                    }
                });
            }
        });
    };

    const gracefullyClosePeerConnection = () => {
        if (peerRef.current && !peerRef.current.destroyed) {
            peerRef.current.destroy();
        }
    };

    // ========== Peer Utility ==========
    const sendToPeer = (conn: DataConnection, data: PeerMessage) => {
        if (conn.open) {
            conn.send(data);
        }
    };

    const sendToAllPeers = (data: PeerMessage) => {
        peerConnections.forEach((conn) => {
            sendToPeer(conn, data);
        });
    };

    const sendToAllPeersExcept = (
        exceptConn: DataConnection | null,
        data: PeerMessage
    ) => {
        peerConnections.forEach((conn) => {
            if (conn !== exceptConn) {
                sendToPeer(conn, data);
            }
        });
    };

    const initialSyncToPeer = (conn: DataConnection, currentQuestion: Question, reoccurrences: Reoccurrence[], startTime: number, wrongAnswersCount: number, correctAnswersCount: number) => {
        console.log("Initial sync to peer:", conn.peer);
        if (!currentQuestion) return;

        sendToPeer(conn, {
            type: "initial_sync",
            startTime,
            correctAnswersCount,
            wrongAnswersCount,
            reoccurrences,
        });

        sendToPeer(conn, {
            type: "question_update",
            question: currentQuestion,
            selectedAnswers,
        });
    };


    // ========== Render ==========
    if (loading) {
        return (
            <Card className="border-0 shadow">
                <Card.Body>
                    <div className="text-center mb-5">
                        <p>Ładowanie quizu...</p>
                        <PropagateLoader color={appContext.theme.getOppositeThemeColor()} size={15}/>
                    </div>
                </Card.Body>
            </Card>
        );
    }

    if (!quiz) {
        if (!appContext.isAuthenticated) {
            return <LoginPrompt/>;
        }
        return (
            <Card className="border-0 shadow">
                <Card.Body>
                    <div className="text-center">
                        <p>Nie udało się załadować quizu, upewnij się że jest on dla Ciebie dostępny lub spróbuj
                            ponownie później.</p>
                        <Button
                            variant={appContext.theme.getTheme()}
                            onClick={() => window.location.reload()}
                            className="d-inline-flex align-items-center gap-1"
                        >
                            <Icon icon="mdi:cloud-refresh-variant"/> Spróbuj ponownie
                        </Button>
                    </div>
                </Card.Body>
            </Card>
        );
    }

    return (
        <>
            <Row className="mt-4">
                <Col className="mb-3" md={showBrainrot ? 6 : 8}>
                    <QuestionCard
                        question={currentQuestion}
                        selectedAnswers={selectedAnswers}
                        setSelectedAnswers={(newSelected) => {
                            // If question is not multiple, unselect everything except the new
                            if (currentQuestion && !currentQuestion.multiple) {
                                setSelectedAnswers(newSelected.length > 0 ? [newSelected[0]] : []);
                                // Also broadcast to peers
                                if (newSelected.length > 0) {
                                    sendToAllPeers({
                                        type: "question_update",
                                        question: currentQuestion,
                                        selectedAnswers: [newSelected[0]],
                                    });
                                }
                            } else {
                                setSelectedAnswers(newSelected);
                                // If multiple, broadcast each toggle
                                if (currentQuestion) {
                                    const last = newSelected[newSelected.length - 1];
                                    if (typeof last !== "undefined") {
                                        sendToAllPeers({
                                            type: "question_update",
                                            question: currentQuestion,
                                            selectedAnswers: newSelected,
                                        });
                                    }
                                }
                            }
                        }}
                        questionChecked={questionChecked}
                        nextAction={nextAction}
                        isQuizFinished={isQuizFinished}
                    />
                </Col>
                <Col md={showBrainrot ? 3 : 4}>
                    <QuizInfoCard
                        quiz={quiz}
                        correctAnswersCount={correctAnswersCount}
                        wrongAnswersCount={wrongAnswersCount}
                        reoccurrences={reoccurrences}
                        studyTime={studyTime}
                        resetProgress={resetProgress}
                    />
                    <QuizActionButtons
                        onCopy={copyToClipboard}
                        onOpenChatGPT={openInChatGPT}
                        onReportIssue={reportIncorrectQuestion}
                        toggleBrainrot={() => setShowBrainrot(!showBrainrot)}
                        isMaintainer={quiz.maintainer?.id === parseInt(localStorage.getItem("user_id") || "")}
                        theme={appContext.theme.getTheme()}
                    />
                </Col>
                {showBrainrot && (
                    <Col md={3}>
                        <Card className="border-0 shadow">
                            <Card.Body>
                                <div className='player-wrapper'>
                                    <ReactPlayer
                                        className='react-player'
                                        url="https://www.youtube.com/watch?v=zZ7AimPACzc"
                                        playing
                                        // muted
                                        loop
                                        width='100%'
                                        height='100%'
                                    />
                                </div>
                            </Card.Body>
                        </Card>
                    </Col>
                )}
            </Row>

            {/* Continuity */}
            <ContinuityModal
                peerConnections={peerConnections}
                isContinuityHost={isContinuityHost}
            />
        </>
    );
};

export default QuizPage;