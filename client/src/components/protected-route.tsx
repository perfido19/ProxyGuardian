import { useAuth } from "@/hooks/use-auth";
import { LoadingState } from "@/components/loading-state";
import Login from "@/pages/login";

interface ProtectedRouteProps {
  children: React.ReactNode;
}

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return <LoadingState message="Verifica sessione..." />;
  }

  if (!isAuthenticated) {
    return <Login />;
  }

  return <>{children}</>;
}
