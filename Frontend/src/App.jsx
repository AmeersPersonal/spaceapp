import { Routes, Route, Link } from 'react-router-dom'

import Home from './pages/Home.jsx'
import SignIn from './pages/SignIn.jsx'
import SignUp from './pages/SignUp.jsx'
import NotFound from './pages/NotFound.jsx'
import './App.css'

function App() {
  return (
    <>
      <nav className="navbar">
        <Link to="/" className="brand">SpaceApp</Link>
        <div className="nav-links">
          <Link to="/signin">Sign In</Link>
          <Link to="/signup">Sign Up</Link>
        </div>
      </nav>

      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/signin" element={<SignIn />} />
          <Route path="/signup" element={<SignUp />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </>
  )
}

export default App
