import React, {useContext, useEffect, useState} from 'react';
import {BrowserRouter as Router, Route, Routes} from 'react-router-dom';
import DashboardPage from './pages/DashboardPage.tsx';
import Navbar from "./components/Navbar.tsx";
import AppContext from "./AppContext.tsx";
import {Theme} from "./Theme.tsx";
import LoginPrompt from "./components/LoginPrompt.tsx";
import ProfilePage from "./pages/ProfilePage.tsx";
import Error404Page from "./pages/errors/Error404Page.tsx";
import ImportQuizPage from "./pages/ImportQuizPage.tsx";
import ImportQuizLegacyPage from "./pages/ImportQuizLegacyPage.tsx";
import CreateQuizPage from "./pages/CreateQuizPage.tsx";
import EditQuizPage from "./pages/EditQuizPage.tsx";
import QuizzesPage from "./pages/QuizzesPage.tsx";


const useThemeDetector = () => {
    const getCurrentTheme = () => window.matchMedia("(prefers-color-scheme: dark)").matches;
    const [theme, setTheme] = useState(getCurrentTheme() ? Theme.DARK : Theme.LIGHT);
    const mqListener = ((e: { matches: boolean | ((prevState: boolean) => boolean); }) => {
        setTheme(e.matches ? Theme.DARK : Theme.LIGHT);
    });

    useEffect(() => {
        const darkThemeMq = window.matchMedia("(prefers-color-scheme: dark)");
        darkThemeMq.addEventListener("change", mqListener);
        return () => darkThemeMq.removeEventListener("change", mqListener);
    }, [theme]);
    return theme
}


const App: React.FC = () => {
    const context = useContext(AppContext);

    context.theme.setTheme(useThemeDetector());

    return (
        <div className="container d-flex flex-column" id="container">
            <Router>
                <Navbar/>
                {context.isAuthenticated && (
                    <Routes>
                        <Route path="/" element={<DashboardPage/>}/>
                        <Route path="/profile" element={<ProfilePage/>}/>
                        <Route path="/create-quiz" element={<CreateQuizPage/>}/>
                        <Route path="/edit-quiz/:quizId" element={<EditQuizPage/>}/>
                        <Route path="/import-quiz" element={<ImportQuizPage/>}/>
                        <Route path="/import-quiz-legacy" element={<ImportQuizLegacyPage/>}/>
                        <Route path="/quizzes" element={<QuizzesPage/>}/>
                        <Route path="*" element={<Error404Page/>}/>
                    </Routes>
                ) || (
                    <Routes>
                        <Route path="*" element={<LoginPrompt/>}/>
                    </Routes>
                )}
            </Router>
        </div>
    );
};

export default App;