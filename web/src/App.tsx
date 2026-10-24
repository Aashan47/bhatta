import { Link, Route, Routes, useParams } from "react-router";
import { Shell } from "./components/Shell";
import { useT } from "./i18n";
import { Certificate } from "./pages/Certificate";
import { Inspect } from "./pages/Inspect";
import { Kiln } from "./pages/Kiln";
import { Ledger } from "./pages/Ledger";
import { MapPage } from "./pages/MapPage";
import { Method } from "./pages/Method";
import { Overview } from "./pages/Overview";

function NotFound() {
  const t = useT();
  return (
    <div className="notfound">
      <h1>{t.notFound.title}</h1>
      <p>{t.notFound.body}</p>
      <Link to="/" className="btn btn-primary">
        {t.notFound.home}
      </Link>
    </div>
  );
}

/** Remount the kiln pages when the id changes, so no per-kiln state (verification, Merkle animation,
 *  forms, certificate checks) carries over from one kiln to the next during in-app navigation. */
function KilnRoute() {
  const { id = "" } = useParams();
  return <Kiln key={id} />;
}
function CertificateRoute() {
  const { id = "" } = useParams();
  return <Certificate key={id} />;
}

export function App() {
  return (
    <Routes>
      <Route path="/kiln/:id/certificate" element={<CertificateRoute />} />
      <Route
        path="*"
        element={
          <Shell>
            <Routes>
              <Route path="/" element={<Overview />} />
              <Route path="/map" element={<MapPage />} />
              <Route path="/kiln/:id" element={<KilnRoute />} />
              <Route path="/inspect" element={<Inspect />} />
              <Route path="/ledger" element={<Ledger />} />
              <Route path="/method" element={<Method />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Shell>
        }
      />
    </Routes>
  );
}
