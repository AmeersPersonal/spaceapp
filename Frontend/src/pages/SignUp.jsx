import SignIn from './SignIn.jsx'

// Same hand-off as sign-in, but Auth0 opens on its "create account" screen.
function SignUp() {
  return <SignIn mode="signup" />
}

export default SignUp
