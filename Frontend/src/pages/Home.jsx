import { useState } from 'react'
import MapView from '../mapview.jsx'
import NisarMap from '../NisarMap.jsx'
import './Home.css'

// The map is the page: it fills the window and the navbar floats over it.
// "NISAR data" reads the backend catalog; "Sample data" is the bundled
// Mount Aso demo, kept for when the catalog is empty or offline.
function Home() {
  const [source, setSource] = useState('nisar')

  return (
    <>
      {source === 'nisar' ? <NisarMap onOpenSample={() => setSource('sample')} /> : <MapView />}
      <div className="source-switch" role="group" aria-label="Map data">
        <button className={source === 'nisar' ? 'active' : ''} onClick={() => setSource('nisar')}>
          NISAR data
        </button>
        <button className={source === 'sample' ? 'active' : ''} onClick={() => setSource('sample')}>
          Sample data
        </button>
      </div>
    </>
  )
}

export default Home
