import { getBrainTree } from "@/lib/brain-tree";
import BrainNav from "./BrainNav";


export default async function BrainLayout({ children }: { children: React.ReactNode }) {
  const { folders } = await getBrainTree();
  return (
    <div className="mx-auto flex w-full max-w-screen-2xl gap-6 p-4 md:p-6">
      <BrainNav folders={folders} />
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
