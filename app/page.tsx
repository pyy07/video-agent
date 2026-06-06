import { BackgroundDecor } from "@/components/home/BackgroundDecor";
import { CreateModeCards } from "@/components/home/CreateModeCards";
import { Header } from "@/components/home/Header";
import { Hero } from "@/components/home/Hero";

export default function HomePage() {
  return (
    <main className="relative min-h-screen bg-hero-gradient">
      <BackgroundDecor />
      <Header />

      <div className="relative z-10 mx-auto flex w-full max-w-6xl flex-col items-center px-8 pb-24">
        <Hero />
        <CreateModeCards />
      </div>
    </main>
  );
}
