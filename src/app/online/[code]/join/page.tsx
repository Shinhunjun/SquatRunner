import ParticipantView from '../../../../components/ParticipantView';

export default async function JoinPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  return <ParticipantView roomCode={code.toUpperCase()} />;
}
