import { ProofIntro, ProofRecordsLoading } from "@/components/proof/proof-layout";

export default function ProofLoading() {
  return (
    <div className="flex flex-col gap-8">
      <ProofIntro loading />
      <ProofRecordsLoading />
    </div>
  );
}
