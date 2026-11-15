import { Routes, Route, Link } from 'react-router-dom'

import Home from './pages/Home.jsx'
import Events from './pages/Events.jsx'
import SignIn from './pages/SignIn.jsx'
import SignUp from './pages/SignUp.jsx'
import NotFound from './pages/NotFound.jsx'
import { useAuth } from './auth.jsx'
import { logoutUrl } from './api.js'
import './App.css'

function App() {
  const { status, user } = useAuth()

  return (
    <>
      <nav className="navbar">
        <Link to="/" className="brand">SpaceApp</Link>
        <div className="nav-links">
          <Link to="/events">Events</Link>
          {status === 'signed-in' ? (
            <>
              <span className="nav-user">{user.name || user.email || 'Signed in'}</span>
              {/* A plain link: signing out is a redirect through the API and Auth0. */}
              <a href={logoutUrl}>Sign Out</a>
            </>
          ) : (
            <>
              <Link to="/signin">Sign In</Link>
              <Link to="/signup">Sign Up</Link>
            </>
          )}
        </div>
      </nav>

      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/events" element={<Events />} />
          <Route path="/events/:eventId" element={<Events />} />
          <Route path="/signin" element={<SignIn />} />
          <Route path="/signup" element={<SignUp />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </>
  )
}

export default App
