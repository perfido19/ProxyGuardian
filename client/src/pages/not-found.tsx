import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertCircle, Home } from "lucide-react";
import { Link } from "wouter";

export default function NotFound() {
  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <Card className="w-full max-w-md">
        <CardContent className="pt-6 text-center space-y-4">
          <div className="flex justify-center">
            <div className="flex items-center justify-center w-16 h-16 rounded-full bg-destructive/10">
              <AlertCircle className="w-8 h-8 text-destructive" />
            </div>
          </div>
          
          <div className="space-y-2">
            <h1 className="text-2xl font-bold">404 - Pagina Non Trovata</h1>
            <p className="text-muted-foreground">
              La pagina che stai cercando non esiste o è stata spostata.
            </p>
          </div>

          <Button asChild data-testid="button-home">
            <Link href="/">
              <Home className="w-4 h-4 mr-2" />
              Torna alla Dashboard
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
