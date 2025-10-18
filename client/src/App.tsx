import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Home from "@/pages/Home";
import Host from "@/pages/Host";
import Viewer from "@/pages/Viewer";
import TestHarness from "@/pages/TestHarness";
import NotFound from "@/pages/not-found";

const ALLOW_HARNESS = import.meta.env.VITE_ALLOW_HARNESS === 'true' || import.meta.env.DEV;

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/host/:id" component={Host} />
      <Route path="/viewer/:id" component={Viewer} />
      {ALLOW_HARNESS && <Route path="/harness" component={TestHarness} />}
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
